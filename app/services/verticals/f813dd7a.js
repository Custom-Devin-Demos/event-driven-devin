const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Gap.com storefront catalog served to the shopping bag page.
 */
const CATALOG = [
  {
    sku: 'GAP-441020',
    name: 'The Hailey Extra Baggy Jean',
    brand: 'Gap',
    price: 89.95,
    category: 'denim',
    color: 'Medium Indigo',
    size: '28',
  },
  {
    sku: 'GAP-441021',
    name: 'The Hailey Low Rise Loose Jean',
    brand: 'Gap',
    price: 89.95,
    category: 'denim',
    color: 'Light Destroy',
    size: '27',
  },
  {
    sku: 'GAP-885210',
    name: '100% Cotton Authentic Shrunken T-Shirt',
    brand: 'Gap',
    price: 34.95,
    category: 'tees',
    color: 'Optic White',
    size: 'M',
  },
  {
    sku: 'GAP-885214',
    name: 'Organic Cotton VintageSoft Raglan T-Shirt',
    brand: 'Gap',
    price: 39.95,
    category: 'tees',
    color: 'Heather Grey',
    size: 'M',
  },
  {
    sku: 'GAP-772045',
    name: '100% Cotton Oversized Sweater',
    brand: 'Gap',
    price: 79.95,
    category: 'sweaters',
    color: 'Oatmeal',
    size: 'S',
  },
];

/**
 * Shipping channels the checkout service can price. Each channel carries the
 * base fee, the free-shipping threshold, and the tax treatment applied to the
 * items assigned to it.
 */
const SHIPPING_METHODS = {
  standard: {
    label: 'Standard (5-7 business days)',
    baseFee: 7.0,
    freeThreshold: 50,
    taxRate: 0.08875,
  },
  express: {
    label: 'Express (2-3 business days)',
    baseFee: 17.0,
    freeThreshold: Infinity,
    taxRate: 0.08875,
  },
  pickup: {
    label: 'Free Store Pickup',
    baseFee: 0,
    freeThreshold: 0,
    taxRate: 0.08875,
  },
};

/**
 * Active promotions keyed by code.
 *
 * Event promotions pair an order-level discount with a gift-with-purchase that
 * ships from the promotions warehouse rather than the customer's chosen
 * shipping channel, so the gift line carries its own shipping method.
 */
const PROMOTIONS = {
  FRIENDS40: {
    label: 'Friends & Family \u2014 40% off everything, includes denim',
    minimumSubtotal: 0,
    discountRate: 0.4,
    giftItem: {
      sku: 'GAP-GIFT-7710',
      name: 'Gap Logo Canvas Tote (gift with purchase)',
      brand: 'Gap',
      price: 0,
      qty: 1,
      shippingMethod: 'promo-parcel',
    },
  },
  ENCORE20: {
    label: 'Encore Credit Card \u2014 extra 20% off your first purchase',
    minimumSubtotal: 0,
    discountRate: 0.2,
    giftItem: null,
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
  'The failing code path is the Gap online storefront checkout vertical:',
  '- Service: `app/services/verticals/f813dd7a.js`',
  '- Route: `app/routes/verticals/f813dd7a.js`',
  '- Page: `app/public/verticals/f813dd7a.html` (served at `/gap`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findProduct(sku) {
  return CATALOG.find((product) => product.sku === sku) || null;
}

/**
 * Resolve the promotion attached to the bag. Codes that do not clear their
 * minimum subtotal are ignored so the order prices without a discount.
 */
function resolvePromotion(promoCode, subtotal) {
  const promotion = promoCode ? PROMOTIONS[promoCode] : null;
  if (!promotion) return null;
  if (subtotal < promotion.minimumSubtotal) return null;
  return promotion;
}

/**
 * Merge the promotion's gift-with-purchase into the bag lines. Gift items are
 * fulfilled by the promotions warehouse rather than the customer's shipping
 * selection, so they carry their own shipping method.
 */
function applyPromotionItems(items, promotion) {
  if (!promotion || !promotion.giftItem) return items;
  return [...items, { ...promotion.giftItem }];
}

/**
 * Group bag lines into shipments, one per shipping method.
 */
function buildShipments(items) {
  const shipments = new Map();

  for (const item of items) {
    const method = item.shippingMethod || 'standard';
    if (!shipments.has(method)) {
      shipments.set(method, { method, items: [] });
    }
    shipments.get(method).items.push(item);
  }

  return [...shipments.values()];
}

/**
 * Price a single shipment: merchandise total, shipping fee, and sales tax.
 */
function computeShipmentTotals(shipment) {
  const rules = SHIPPING_METHODS[shipment.method];
  const merchandise = shipment.items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const shipping = merchandise >= rules.freeThreshold ? 0 : rules.baseFee;

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
function buildOrderSummary(orderId, items, shipments, promotion) {
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
    itemCount: items.reduce((sum, item) => sum + item.qty, 0),
    itemTotal: Math.round(merchandise * 100) / 100,
    savings: Math.round(savings * 100) / 100,
    savingsLabel: promotion ? promotion.label : 'None',
    shippingTotal: Math.round(shipping * 100) / 100,
    estimatedTax: Math.round(tax * 100) / 100,
    total: Math.round((merchandise - savings + shipping + tax) * 100) / 100,
    shipments,
    placedAt: new Date().toISOString(),
  };
}

/**
 * Place a shopping bag order.
 */
async function placeOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  const bagItems = (data.items || []).map((item) => {
    const product = findProduct(item.sku);
    return {
      sku: item.sku,
      name: product ? product.name : item.name || 'Item',
      brand: product ? product.brand : item.brand || 'Gap',
      price: product ? product.price : Number(item.price) || 0,
      qty: Number(item.qty) || 1,
      shippingMethod: item.shippingMethod || 'standard',
    };
  });

  logger.info('Placing Gap shopping bag order', {
    orderId,
    lines: bagItems.length,
    promoCode: data.promoCode,
    zipCode: data.zipCode,
    service: 'customer-f813dd7a-checkout',
    route: '/api/f813dd7a/checkout',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const subtotal = bagItems.reduce((sum, item) => sum + item.price * item.qty, 0);
    const promotion = resolvePromotion(data.promoCode, subtotal);
    const allItems = applyPromotionItems(bagItems, promotion);
    const shipments = buildShipments(allItems).map(computeShipmentTotals);
    const summary = buildOrderSummary(orderId, allItems, shipments, promotion);

    const duration = Date.now() - startTime;

    incrementMetric('bag_checkout.success', {
      route: '/api/f813dd7a/checkout',
      promo: data.promoCode || 'none',
    });
    recordTiming('bag_checkout.latency', duration, {
      route: '/api/f813dd7a/checkout',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('bag_checkout.failure', {
      route: '/api/f813dd7a/checkout',
      errorClass: error.name,
      promo: data.promoCode || 'none',
    });
    recordTiming('bag_checkout.latency', duration, {
      route: '/api/f813dd7a/checkout',
      error: 'true',
    });

    logger.error('Gap shopping bag checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      promoCode: data.promoCode,
      lines: bagItems.length,
      service: 'customer-f813dd7a-checkout',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/f813dd7a/checkout',
        service: 'customer-f813dd7a-checkout',
        promo: data.promoCode,
      },
      extra: {
        orderId,
        promoCode: data.promoCode,
        zipCode: data.zipCode,
        lines: bagItems.length,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f813dd7a.js \u2014 computeShipmentTotals',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-f813dd7a-checkout',
      verticalLabel: 'Gap Online Checkout',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'f813dd7a',
      tags: [
        { key: 'route', value: '/api/f813dd7a/checkout' },
        { key: 'service', value: 'customer-f813dd7a-checkout' },
        { key: 'promo', value: data.promoCode },
      ],
      extra: {
        orderId,
        promoCode: data.promoCode,
        zipCode: data.zipCode,
        lines: bagItems.length,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-f813dd7a-checkout@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for Gap checkout error', {
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
  SHIPPING_METHODS,
  buildShipments,
  computeShipmentTotals,
  applyPromotionItems,
  resolvePromotion,
};
