const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Verizon product catalog — wireless devices, plans, and add-ons.
 * Price is the monthly USD amount (device financing / plan / add-on).
 */
const CATALOG = [
  { id: 'VZ-DEV-IP17P-256', name: 'iPhone 17 Pro 256 GB', price: 45.83, category: 'device', term: '36-mo Device Payment' },
  { id: 'VZ-DEV-S26U-512', name: 'Samsung Galaxy S26 Ultra 512 GB', price: 41.66, category: 'device', term: '36-mo Device Payment' },
  { id: 'VZ-DEV-PX10P-128', name: 'Google Pixel 10 Pro 128 GB', price: 33.33, category: 'device', term: '36-mo Device Payment' },
  { id: 'VZ-PLN-UNL-ULT', name: 'Unlimited Ultimate', price: 90.00, category: 'plan', term: 'myPlan · Month-to-month' },
  { id: 'VZ-PLN-UNL-PLUS', name: 'Unlimited Plus', price: 80.00, category: 'plan', term: 'myPlan · Month-to-month' },
  { id: 'VZ-PLN-UNL-WEL', name: 'Unlimited Welcome', price: 65.00, category: 'plan', term: 'myPlan · Month-to-month' },
  { id: 'VZ-ADD-VMP', name: 'Verizon Mobile Protect', price: 18.00, category: 'add-on', term: 'Monthly' },
  { id: 'VZ-ADD-TRAVELPASS', name: 'TravelPass — Mexico & Canada', price: 12.00, category: 'add-on', term: 'Monthly' },
  { id: 'VZ-ADD-HOTSPOT', name: 'Unlimited Hotspot Perk', price: 10.00, category: 'add-on', term: 'Monthly' },
];

/**
 * State tax configuration
 */
const STATES = {
  NY: { taxRate: 0.08875, taxLabel: 'Sales tax', currency: 'USD' },
  NJ: { taxRate: 0.06625, taxLabel: 'Sales tax', currency: 'USD' },
  CA: { taxRate: 0.0725, taxLabel: 'Sales tax', currency: 'USD' },
  TX: { taxRate: 0.0625, taxLabel: 'Sales tax', currency: 'USD' },
  FL: { taxRate: 0.06, taxLabel: 'Sales tax', currency: 'USD' },
  IL: { taxRate: 0.0625, taxLabel: 'Sales tax', currency: 'USD' },
};

/**
 * Active promotions — applied server-side for the fall 2026 launch campaign.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-DISNEY-2026', name: 'Disney+, Hulu, ESPN+ Bundle — myPlan perk', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 150) return { rate: 0.10, label: 'myPlan bundle savings (10%)' };
  if (subtotal >= 100) return { rate: 0.05, label: 'myPlan bundle savings (5%)' };
  return { rate: 0, label: 'None' };
}

/**
 * Merges promotional items into the order line items.
 */
function applyPromotions(items) {
  return [...items, ...ACTIVE_PROMOTIONS];
}

/**
 * Computes the final order total.
 */
function computeOrderTotal(subtotal, state) {
  const taxConfig = STATES[state];
  if (!taxConfig) {
    throw Object.assign(new Error(`Unknown state: ${state}`), { code: 'INVALID_STATE' });
  }
  const tax = subtotal * taxConfig.taxRate;
  const discount = getApplicableDiscount(subtotal);
  const discountAmount = (subtotal + tax) * discount.rate;
  return {
    subtotal,
    tax: Math.round(tax * 100) / 100,
    discount: Math.round(discountAmount * 100) / 100,
    discountLabel: discount.label,
    total: Math.round((subtotal + tax - discountAmount) * 100) / 100,
    taxLabel: taxConfig.taxLabel,
    currency: taxConfig.currency,
  };
}

/**
 * Formats a receipt for the order confirmation.
 * BUG: PROMO-DISNEY-2026 is not in CATALOG, so product.name crashes.
 */
function formatReceipt(allItems) {
  return allItems.map((item) => {
    const product = CATALOG.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: product.name,
      category: product.category,
      term: product.term,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * Processes a Verizon wireless checkout order.
 */
async function processCheckout(orderData) {
  if (!STATES[orderData.state]) {
    throw Object.assign(new Error(`Unknown state: ${orderData.state}`), {
      name: 'ValidationError',
      code: 'INVALID_STATE',
      status: 400,
    });
  }

  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Verizon checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'verizon-ecommerce',
    route: '/api/4e150e99/checkout',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyPromotions(orderData.items);

    const computedSubtotal = allItems.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    ) || orderData.subtotal;

    const finalSubtotal = typeof computedSubtotal === 'string'
      ? parseFloat(computedSubtotal)
      : computedSubtotal;

    const result = computeOrderTotal(finalSubtotal, orderData.state);
    const receipt = formatReceipt(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/4e150e99/checkout',
      source: 'verizon-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/4e150e99/checkout',
    });

    return {
      success: true,
      orderId,
      total: result.total,
      tax: result.tax,
      taxLabel: result.taxLabel,
      discount: result.discount,
      discountLabel: result.discountLabel,
      currency: result.currency,
      receipt,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/4e150e99/checkout',
      errorClass: error.name,
      source: 'verizon-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/4e150e99/checkout',
      error: 'true',
    });

    logger.error('Verizon checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'verizon-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/4e150e99/checkout',
        service: 'verizon-ecommerce',
        source: 'verizon-storefront',
        alert_path: 'instant',
      },
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        state: orderData.state,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4e150e99.js — formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      customer: '4e150e99',
      service: 'verizon-ecommerce',
      verticalLabel: 'Verizon Checkout',
      tags: [
        { key: 'route', value: '/api/4e150e99/checkout' },
        { key: 'service', value: 'verizon-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'verizon-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Verizon checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, getApplicableDiscount, CATALOG, STATES };
