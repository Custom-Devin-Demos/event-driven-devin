const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Storefront catalog served to the cart page.
 */
const CATALOG = [
  {
    sku: '1005643790',
    name: 'ONE+ 18V Cordless 3/8 in. Drill/Driver Kit with Battery and Charger',
    brand: 'RYOBI',
    price: 49.97,
    category: 'power-tools',
    limitPerOrder: 5,
  },
  {
    sku: '1004442745',
    name: 'Drill and Impact Drive Kit (40-Piece)',
    brand: 'RYOBI',
    price: 15.97,
    category: 'accessories',
    limitPerOrder: 10,
  },
  {
    sku: '1002563912',
    name: 'Black and Gold Twist Drill Bit Set (21-Piece)',
    brand: 'DEWALT',
    price: 24.97,
    category: 'accessories',
    limitPerOrder: 10,
  },
  {
    sku: '1000734512',
    name: 'StudSensor HD55 Stud Finder',
    brand: 'Zircon',
    price: 19.97,
    category: 'tools',
    limitPerOrder: 10,
  },
];

/**
 * Fulfillment channels the checkout service can price. Each channel carries the
 * tax treatment and shipping surcharge applied to the items assigned to it.
 */
const FULFILLMENT_METHODS = {
  delivery: {
    label: 'Delivery',
    taxRate: 0.08875,
    surcharge: 0,
    freeThreshold: 45,
  },
  pickup: {
    label: 'At Your Store',
    taxRate: 0.08875,
    surcharge: 0,
    freeThreshold: 0,
  },
  'ship-to-store': {
    label: 'Ship to Store',
    taxRate: 0.08875,
    surcharge: 0,
    freeThreshold: 0,
  },
};

/**
 * Active cart promotions keyed by code.
 *
 * Card-acquisition promotions pair an order discount with a bonus item that is
 * fulfilled separately from the items the customer added to the cart.
 */
const PROMOTIONS = {
  HDCC25: {
    label: 'Home Depot Credit Card \u2014 $25 off your qualifying purchase of $25+',
    minimumSubtotal: 25,
    discount: 25,
    bonusItem: {
      sku: 'RYOBI-P190-GIFT',
      name: 'ONE+ 18V 2 Ah Lithium Battery (bonus item)',
      brand: 'RYOBI',
      price: 0,
      qty: 1,
      fulfillment: 'promo-gift',
    },
  },
  SPRINGSAVE10: {
    label: 'Spring Savings \u2014 10% off orders $100+',
    minimumSubtotal: 100,
    discountRate: 0.1,
    bonusItem: null,
  },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is The Home Depot online cart checkout vertical:',
  '- Service: `app/services/verticals/a69bcc34.js`',
  '- Route: `app/routes/verticals/a69bcc34.js`',
  '- Page: `app/public/verticals/a69bcc34.html` (served at `/homedepot`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findProduct(sku) {
  return CATALOG.find((product) => product.sku === sku) || null;
}

/**
 * Resolve the promotion attached to the cart. Codes that do not clear their
 * minimum subtotal are ignored so the order prices without a discount.
 */
function resolvePromotion(promoCode, subtotal) {
  const promotion = promoCode ? PROMOTIONS[promoCode] : null;
  if (!promotion) return null;
  if (subtotal < promotion.minimumSubtotal) return null;
  return promotion;
}

/**
 * Merge the promotion's bonus item into the cart lines. Bonus items are
 * fulfilled by the promotions warehouse rather than the store or delivery
 * network, so they carry their own fulfillment channel.
 */
function applyPromotionItems(items, promotion) {
  if (!promotion || !promotion.bonusItem) return items;
  return [...items, { ...promotion.bonusItem }];
}

/**
 * Group cart lines into shipments, one per fulfillment channel.
 */
function buildShipments(items) {
  const shipments = new Map();

  for (const item of items) {
    const method = item.fulfillment || 'delivery';
    if (!shipments.has(method)) {
      shipments.set(method, { method, items: [] });
    }
    shipments.get(method).items.push(item);
  }

  return [...shipments.values()];
}

/**
 * Price a single shipment: merchandise total, shipping, and sales tax.
 */
function computeShipmentTotals(shipment) {
  const rules = FULFILLMENT_METHODS[shipment.method];
  const merchandise = shipment.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const shipping = merchandise >= rules.freeThreshold ? 0 : rules.surcharge;

  return {
    method: shipment.method,
    label: rules.label,
    lines: shipment.items.length,
    merchandise: Math.round(merchandise * 100) / 100,
    shipping: Math.round(shipping * 100) / 100,
    tax: Math.round(merchandise * rules.taxRate * 100) / 100,
  };
}

/**
 * Build the order summary shown on the confirmation screen.
 */
function buildOrderSummary(orderId, items, shipments, promotion, storeNumber) {
  const merchandise = shipments.reduce((sum, shipment) => sum + shipment.merchandise, 0);
  const shipping = shipments.reduce((sum, shipment) => sum + shipment.shipping, 0);
  const tax = shipments.reduce((sum, shipment) => sum + shipment.tax, 0);

  let savings = 0;
  if (promotion) {
    savings = promotion.discount || merchandise * promotion.discountRate;
  }

  return {
    success: true,
    orderId,
    status: 'confirmed',
    storeNumber,
    itemCount: items.reduce((sum, item) => sum + item.qty, 0),
    itemTotal: Math.round(merchandise * 100) / 100,
    savings: Math.round(savings * 100) / 100,
    savingsLabel: promotion ? promotion.label : 'None',
    delivery: Math.round(shipping * 100) / 100,
    estimatedTax: Math.round(tax * 100) / 100,
    total: Math.round((merchandise - savings + shipping + tax) * 100) / 100,
    shipments,
    placedAt: new Date().toISOString(),
  };
}

/**
 * Place an online cart order.
 */
async function placeOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  const cartItems = (data.items || []).map((item) => {
    const product = findProduct(item.sku);
    return {
      sku: item.sku,
      name: product ? product.name : item.name || 'Item',
      brand: product ? product.brand : item.brand || '',
      price: product ? product.price : Number(item.price) || 0,
      qty: Number(item.qty) || 1,
      fulfillment: item.fulfillment || 'delivery',
    };
  });

  logger.info('Placing online cart order', {
    orderId,
    lines: cartItems.length,
    promoCode: data.promoCode,
    storeNumber: data.storeNumber,
    zipCode: data.zipCode,
    service: 'customer-a69bcc34-checkout',
    route: '/api/a69bcc34/checkout',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const subtotal = cartItems.reduce((sum, item) => sum + item.price * item.qty, 0);
    const promotion = resolvePromotion(data.promoCode, subtotal);
    const allItems = applyPromotionItems(cartItems, promotion);
    const shipments = buildShipments(allItems).map(computeShipmentTotals);
    const summary = buildOrderSummary(orderId, allItems, shipments, promotion, data.storeNumber);

    const duration = Date.now() - startTime;

    incrementMetric('cart_checkout.success', {
      route: '/api/a69bcc34/checkout',
      promo: data.promoCode || 'none',
    });
    recordTiming('cart_checkout.latency', duration, {
      route: '/api/a69bcc34/checkout',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('cart_checkout.failure', {
      route: '/api/a69bcc34/checkout',
      errorClass: error.name,
      promo: data.promoCode || 'none',
    });
    recordTiming('cart_checkout.latency', duration, {
      route: '/api/a69bcc34/checkout',
      error: 'true',
    });

    logger.error('Online cart checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      promoCode: data.promoCode,
      storeNumber: data.storeNumber,
      lines: cartItems.length,
      service: 'customer-a69bcc34-checkout',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/a69bcc34/checkout',
        service: 'customer-a69bcc34-checkout',
        promo: data.promoCode,
      },
      extra: {
        orderId,
        promoCode: data.promoCode,
        storeNumber: data.storeNumber,
        zipCode: data.zipCode,
        lines: cartItems.length,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/a69bcc34.js \u2014 computeShipmentTotals',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-a69bcc34-checkout',
      verticalLabel: 'Online Cart Checkout',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'a69bcc34',
      slackMemberId: 'U0BKV8PTK6F',
      tags: [
        { key: 'route', value: '/api/a69bcc34/checkout' },
        { key: 'service', value: 'customer-a69bcc34-checkout' },
        { key: 'promo', value: data.promoCode },
        { key: 'store', value: data.storeNumber },
      ],
      extra: {
        orderId,
        promoCode: data.promoCode,
        storeNumber: data.storeNumber,
        zipCode: data.zipCode,
        lines: cartItems.length,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-a69bcc34-checkout@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for cart checkout error', {
        error: err.message,
        orderId,
      });
    });

    throw error;
  }
}

module.exports = {
  placeOrder,
  REMEDIATION_DIRECTIVE,
  CATALOG,
  PROMOTIONS,
  FULFILLMENT_METHODS,
  buildShipments,
  computeShipmentTotals,
  applyPromotionItems,
  resolvePromotion,
};
