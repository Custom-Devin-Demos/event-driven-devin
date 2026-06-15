const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Walgreens product catalog — pharmacy & wellness SKUs
 */
const CATALOG = [
  { id: 'WAG-TYL-XS', name: 'Tylenol Extra Strength 500mg (100ct)', price: 12.99, category: 'pain-relief', form: 'Caplets' },
  { id: 'WAG-CLR-24', name: 'Claritin 24HR Allergy (30ct)', price: 24.99, category: 'allergy', form: 'Tablets' },
  { id: 'WAG-VITD-90', name: 'Walgreens Vitamin D3 2000 IU (90ct)', price: 9.49, category: 'vitamins', form: 'Softgels' },
  { id: 'WAG-NYQ-12', name: 'NyQuil Cold & Flu Nighttime (12oz)', price: 13.49, category: 'cough-cold', form: 'Liquid' },
  { id: 'WAG-BPM-AUTO', name: 'Walgreens Automatic Blood Pressure Monitor', price: 39.99, category: 'health-devices', form: 'Device' },
  { id: 'WAG-FLU-TST', name: 'At-Home Flu & COVID Test Kit (2ct)', price: 19.99, category: 'diagnostics', form: 'Kit' },
  { id: 'WAG-BAND-FX', name: 'Band-Aid Flexible Fabric (100ct)', price: 6.49, category: 'first-aid', form: 'Bandages' },
  { id: 'WAG-PRO-50', name: 'Walgreens SPF 50 Sunscreen Lotion (8oz)', price: 8.99, category: 'skin-care', form: 'Lotion' },
];

/**
 * State-level tax configuration for store fulfillment
 */
const TAX_REGIONS = {
  IL: { taxRate: 0.0625, currency: 'USD' },
  NY: { taxRate: 0.08875, currency: 'USD' },
  CA: { taxRate: 0.0725, currency: 'USD' },
  TX: { taxRate: 0.0625, currency: 'USD' },
};

/**
 * Active promotions — "myWalgreens Cash rewards" campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-WAG-CASH-2026', name: 'myWalgreens Cash Reward', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 75) return { rate: 0.15, label: '15% off orders $75+' };
  if (subtotal >= 50) return { rate: 0.10, label: '10% off orders $50+' };
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
function computeOrderTotal(subtotal, region) {
  const taxConfig = TAX_REGIONS[region];
  if (!taxConfig) {
    throw Object.assign(new Error(`Unknown tax region: ${region}`), { code: 'INVALID_REGION' });
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
    currency: taxConfig.currency,
  };
}

/**
 * Formats a receipt for the order confirmation.
 * BUG: PROMO-WAG-CASH-2026 is not in CATALOG, so product.name crashes.
 */
function formatReceipt(allItems) {
  return allItems.map((item) => {
    const product = CATALOG.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: product.name,
      category: product.category,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * Processes a Walgreens pharmacy & wellness checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Walgreens checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'walgreens-pharmacy',
    route: '/api/walgreens/checkout',
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

    const result = computeOrderTotal(finalSubtotal, orderData.region);
    const receipt = formatReceipt(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/walgreens/checkout',
      source: 'walgreens-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/walgreens/checkout',
    });

    return {
      success: true,
      orderId,
      total: result.total,
      tax: result.tax,
      discount: result.discount,
      discountLabel: result.discountLabel,
      receipt,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/walgreens/checkout',
      errorClass: error.name,
      source: 'walgreens-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/walgreens/checkout',
      error: 'true',
    });

    logger.error('Walgreens checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'walgreens-pharmacy',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/walgreens/checkout',
        service: 'walgreens-pharmacy',
        source: 'walgreens-storefront',
      },
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        region: orderData.region,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/walgreens.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'walgreens-pharmacy',
      verticalLabel: 'Walgreens Checkout',
      tags: [
        { key: 'route', value: '/api/walgreens/checkout' },
        { key: 'service', value: 'walgreens-pharmacy' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'walgreens-pharmacy@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Walgreens checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
