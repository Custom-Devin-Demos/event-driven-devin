const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER = 'mms';
const PAGE = '/m&m';
const VERTICAL_LABEL = "M&M'S Cart";
const CHECKOUT_ROUTE = '/api/mms/checkout';
const PROMO_ROUTE = '/api/mms/promo';
const CHECKOUT_SERVICE = 'mms-checkout';
const PROMO_SERVICE = 'mms-promotions';

const SLACK_MEMBER_ID_FALLBACK = process.env.SLACK_MEMBER_ID_MMS || '';

const PRODUCTS = {
  '701130-90450': {
    sku: '701130-90450',
    name: 'personalized clear party favors',
    unitPrice: 2.75,
    minQty: 20,
    qtyStep: 5,
    collection: 'personalized-favors',
    taxCategory: 'personalized-confectionery',
  },
};

const FREE_STANDARD_SHIPPING_THRESHOLD = 75;

const SHIPPING_METHODS = {
  standard: { id: 'standard', label: 'Standard shipping', price: 9.99, transitDays: 9 },
  express: { id: 'express', label: 'Express shipping', price: 29.99, transitDays: 6 },
};

// First three ZIP digits -> state, for the states we ship to.
const ZIP3_STATES = [
  [10, 27, 'MA'],
  [70, 89, 'NJ'],
  [100, 149, 'NY'],
  [150, 196, 'PA'],
  [320, 349, 'FL'],
  [600, 629, 'IL'],
  [750, 799, 'TX'],
  [900, 961, 'CA'],
];

// Combined sales tax rate by state and product tax category.
const SALES_TAX = {
  MA: { categories: { 'candy-confectionery': { rate: 0.0625 }, 'personalized-confectionery': { rate: 0.0625 } } },
  NJ: { categories: { 'candy-confectionery': { rate: 0.06625 }, 'personalized-confectionery': { rate: 0.06625 } } },
  NY: { categories: { 'candy-confectionery': { rate: 0.08875 } } },
  PA: { categories: { 'candy-confectionery': { rate: 0.06 }, 'personalized-confectionery': { rate: 0.06 } } },
  FL: { categories: { 'candy-confectionery': { rate: 0.07 }, 'personalized-confectionery': { rate: 0.07 } } },
  IL: { categories: { 'candy-confectionery': { rate: 0.1025 }, 'personalized-confectionery': { rate: 0.1025 } } },
  TX: { categories: { 'candy-confectionery': { rate: 0.0825 }, 'personalized-confectionery': { rate: 0.0825 } } },
  CA: { categories: { 'candy-confectionery': { rate: 0.095 }, 'personalized-confectionery': { rate: 0.095 } } },
};

const PROMOTIONS = {
  FAVORS10: {
    code: 'FAVORS10',
    label: '10% off personalized party favors',
    percentOff: 10,
    eligibility: { skus: ['701130-90450'], minSubtotal: 0 },
  },
  SWEET15: {
    code: 'SWEET15',
    label: '15% off orders $40+',
    percentOff: 15,
    eligibility: { minSubtotal: 40 },
  },
};

function directive(surface, details) {
  return [
    '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
    '',
    `Scope: only the M&M'S cart ${surface} failure below. This repository hosts many independent demo verticals, each with its own intentional bug; do not modify any other vertical.`,
    '',
    'The failing surface is the M&M\'S cart page:',
    `- Page: \`app/public/verticals/mms.html\` (served at \`${PAGE}\` and \`/mms\`)`,
    '- Route: `app/routes/verticals/mms.js`',
    '- Service: `app/services/verticals/mms.js`',
    '',
    ...details,
    '',
    `Open a pull request against \`main\` with the fix and verify it end-to-end in a browser on the \`${PAGE}\` page, then confirm \`npm run lint\` and \`npm test\` pass.`,
  ].join('\n');
}

const CHECKOUT_DIRECTIVE = directive('checkout', [
  'The "check out" button posts to `POST /api/mms/checkout`: checkout -> priceCart -> calculateSalesTax.',
  'Start from the shipping ZIP in the alert\'s `ship_state` tag and work back to the sales tax table for that state and the product\'s tax category.',
  'Unsupported destinations must stay a handled 400, never a TypeError.',
]);

const PROMO_DIRECTIVE = directive('promo code', [
  'The "apply" button posts to `POST /api/mms/promo`: applyPromo -> computeDiscount.',
  'Start from the code in the alert\'s `promo_code` tag and compare its eligibility rules with what computeDiscount expects.',
  'Unknown or ineligible codes must stay a handled 400, never a TypeError.',
]);

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

function buildLineItems(items) {
  const list = Array.isArray(items) ? items : [];
  const lineItems = list.map((item) => {
    const product = PRODUCTS[item && item.sku];
    if (!product) throw validationError('This item is no longer available.', 'UNKNOWN_SKU');
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < product.minQty || (qty - product.minQty) % product.qtyStep !== 0) {
      throw validationError(
        `Minimum of ${product.minQty} required. Available in increments of ${product.qtyStep}.`,
        'INVALID_QUANTITY',
      );
    }
    return {
      sku: product.sku,
      name: product.name,
      qty,
      unitPrice: product.unitPrice,
      lineTotal: roundCents(product.unitPrice * qty),
      collection: product.collection,
      taxCategory: product.taxCategory,
    };
  });
  if (lineItems.length === 0) throw validationError('Your cart is empty.', 'EMPTY_CART');
  return lineItems;
}

function subtotalOf(lineItems) {
  return roundCents(lineItems.reduce((sum, li) => sum + li.lineTotal, 0));
}

function stateForZip(zip) {
  const value = String(zip || '').trim();
  if (!/^\d{5}$/.test(value)) throw validationError('please input 5 digits', 'INVALID_ZIP');
  const zip3 = Number(value.slice(0, 3));
  const match = ZIP3_STATES.find(([low, high]) => zip3 >= low && zip3 <= high);
  if (!match) throw validationError('We are unable to ship to this zip code.', 'UNSUPPORTED_ZIP');
  return match[2];
}

function formatDeliveryDate(transitDays, now = new Date()) {
  const date = new Date(now.getTime() + transitDays * 24 * 60 * 60 * 1000);
  return date.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric', timeZone: 'America/New_York',
  });
}

function shippingOptions(subtotal, now) {
  return Object.values(SHIPPING_METHODS).map((method) => {
    const free = method.id === 'standard' && subtotal >= FREE_STANDARD_SHIPPING_THRESHOLD;
    return {
      id: method.id,
      label: method.label,
      price: free ? 0 : method.price,
      estimatedDelivery: formatDeliveryDate(method.transitDays, now),
    };
  });
}

function computeDiscount(promo, lineItems) {
  const subtotal = subtotalOf(lineItems);
  if (subtotal < (promo.eligibility.minSubtotal || 0)) {
    throw validationError(`Add $${(promo.eligibility.minSubtotal - subtotal).toFixed(2)} more to use this code.`, 'PROMO_MIN_SUBTOTAL');
  }
  const eligible = lineItems.filter((li) => promo.eligibility.skus.includes(li.sku));
  if (eligible.length === 0) throw validationError('This promo code does not apply to the items in your cart.', 'PROMO_NOT_ELIGIBLE');
  return roundCents(subtotalOf(eligible) * (promo.percentOff / 100));
}

function findPromotion(code) {
  const key = String(code || '').trim().toUpperCase();
  if (!key) throw validationError('Please enter a promo code.', 'PROMO_REQUIRED');
  if (!Object.hasOwn(PROMOTIONS, key)) throw validationError('The promo code you entered is not valid.', 'PROMO_INVALID');
  return PROMOTIONS[key];
}

function calculateSalesTax(state, lineItems, discount) {
  const jurisdiction = SALES_TAX[state];
  const subtotal = subtotalOf(lineItems);
  return roundCents(lineItems.reduce((sum, li) => {
    const share = subtotal > 0 ? li.lineTotal / subtotal : 0;
    const taxable = li.lineTotal - discount * share;
    return sum + taxable * jurisdiction.categories[li.taxCategory].rate;
  }, 0));
}

function reportFailure(error, context) {
  const {
    service, route, culprit, promptAppendix, tags, extra, data, metric,
  } = context;
  const duration = Date.now() - context.startTime;

  incrementMetric(`${metric}.failure`, { route, errorClass: error.name });
  recordTiming(`${metric}.latency`, duration, { route, error: 'true' });
  logger.error("M&M'S cart request failed", {
    route, service, error: error.message, errorClass: error.name, durationMs: duration, ...extra,
  });

  Sentry.captureException(error, {
    tags: {
      route, service, alert_path: 'instant', ...tags,
    },
    extra,
  });

  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(`is:unresolved service:${service}`)}`,
    culprit,
    errorType: error.name || 'Error',
    errorValue: error.message,
    service,
    verticalLabel: VERTICAL_LABEL,
    customer: CUSTOMER,
    slackMemberId: data.devinEmail ? undefined : (SLACK_MEMBER_ID_FALLBACK || undefined),
    devinUserId: data.devinUserId,
    devinOrgId: data.devinOrgId,
    devinEmail: data.devinEmail,
    promptAppendix,
    tags: [
      { key: 'route', value: route },
      { key: 'service', value: service },
      ...Object.entries(tags).map(([key, value]) => ({ key, value })),
    ],
    extra,
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: `${service}@1.0.0`,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).catch((alertError) => {
    logger.error("Failed to trigger Devin session from M&M'S cart error", { route, error: alertError.message });
  });
}

function getCart() {
  return {
    products: Object.values(PRODUCTS).map((product) => ({
      sku: product.sku, name: product.name, unitPrice: product.unitPrice, minQty: product.minQty, qtyStep: product.qtyStep,
    })),
    freeStandardShippingThreshold: FREE_STANDARD_SHIPPING_THRESHOLD,
    shippingMethods: Object.values(SHIPPING_METHODS).map(({ id, label, price }) => ({ id, label, price })),
  };
}

function estimateShipping(data, now = new Date()) {
  const lineItems = buildLineItems(data.items);
  const state = stateForZip(data.zip);
  const subtotal = subtotalOf(lineItems);
  return {
    success: true,
    zip: String(data.zip).trim(),
    state,
    subtotal,
    awayFromFreeShipping: roundCents(Math.max(0, FREE_STANDARD_SHIPPING_THRESHOLD - subtotal)),
    options: shippingOptions(subtotal, now),
  };
}

async function applyPromo(data) {
  const startTime = Date.now();
  const lineItems = buildLineItems(data.items);
  const promo = findPromotion(data.code);

  try {
    const discount = computeDiscount(promo, lineItems);
    incrementMetric('mms_promo.success', { route: PROMO_ROUTE });
    recordTiming('mms_promo.latency', Date.now() - startTime, { route: PROMO_ROUTE });
    return {
      success: true, code: promo.code, label: promo.label, discount,
    };
  } catch (error) {
    if (error.statusCode === 400) throw error;
    reportFailure(error, {
      startTime,
      data,
      metric: 'mms_promo',
      service: PROMO_SERVICE,
      route: PROMO_ROUTE,
      culprit: 'app/services/verticals/mms.js — computeDiscount',
      promptAppendix: PROMO_DIRECTIVE,
      tags: { promo_code: promo.code },
      extra: { promoCode: promo.code, items: lineItems.map((li) => `${li.sku}x${li.qty}`).join(',') },
    });
    throw error;
  }
}

async function checkout(data, now = new Date()) {
  const startTime = Date.now();
  const orderId = uuidv4();
  const lineItems = buildLineItems(data.items);
  const state = stateForZip(data.zip);
  const method = SHIPPING_METHODS[data.shippingMethod];
  if (!method) throw validationError('Please select a shipping method.', 'SHIPPING_METHOD_REQUIRED');
  const promo = data.promoCode ? findPromotion(data.promoCode) : null;

  logger.info("Processing M&M'S cart checkout", {
    orderId, service: CHECKOUT_SERVICE, route: CHECKOUT_ROUTE, shipState: state, shippingMethod: method.id,
  });

  try {
    await new Promise((resolve) => { setTimeout(resolve, 60 + Math.random() * 120); });

    const subtotal = subtotalOf(lineItems);
    const discount = promo ? computeDiscount(promo, lineItems) : 0;
    const shipping = shippingOptions(subtotal, now).find((option) => option.id === method.id).price;
    const salesTax = calculateSalesTax(state, lineItems, discount);
    const total = roundCents(subtotal - discount + shipping + salesTax);

    incrementMetric('mms_checkout.success', { route: CHECKOUT_ROUTE });
    recordTiming('mms_checkout.latency', Date.now() - startTime, { route: CHECKOUT_ROUTE });

    return {
      success: true,
      orderId,
      orderNumber: `MMS${orderId.replace(/-/g, '').slice(0, 8).toUpperCase()}`,
      items: lineItems.map((li) => ({
        sku: li.sku, name: li.name, qty: li.qty, unitPrice: li.unitPrice, lineTotal: li.lineTotal,
      })),
      subtotal,
      discount,
      shipping,
      salesTax,
      total,
      shippingMethod: method.id,
      estimatedDelivery: formatDeliveryDate(method.transitDays, now),
      currency: 'USD',
    };
  } catch (error) {
    if (error.statusCode === 400) throw error;
    reportFailure(error, {
      startTime,
      data,
      metric: 'mms_checkout',
      service: CHECKOUT_SERVICE,
      route: CHECKOUT_ROUTE,
      culprit: 'app/services/verticals/mms.js — calculateSalesTax',
      promptAppendix: CHECKOUT_DIRECTIVE,
      tags: { ship_state: state, shipping_method: method.id },
      extra: {
        orderId, shipZip: String(data.zip).trim(), shipState: state, items: lineItems.map((li) => `${li.sku}x${li.qty}`).join(','),
      },
    });
    throw error;
  }
}

module.exports = {
  getCart,
  estimateShipping,
  applyPromo,
  checkout,
  calculateSalesTax,
  computeDiscount,
  stateForZip,
  PRODUCTS,
  PROMOTIONS,
  SALES_TAX,
  SHIPPING_METHODS,
  FREE_STANDARD_SHIPPING_THRESHOLD,
};
