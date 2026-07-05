const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Pepsi Shop product catalog — consumer e-commerce SKUs
 */
const CATALOG = [
  { id: 'PEP-CLS-12', name: 'Pepsi\u00AE 12-Pack (12 fl oz cans)', price: 7.99, category: 'soft-drinks', flavor: 'Cola' },
  { id: 'PEP-ZER-12', name: 'Pepsi\u00AE Zero Sugar 12-Pack', price: 7.99, category: 'soft-drinks', flavor: 'Zero Sugar' },
  { id: 'PEP-DIET-12', name: 'Diet Pepsi\u00AE 12-Pack', price: 7.99, category: 'soft-drinks', flavor: 'Diet' },
  { id: 'PEP-CHRY-12', name: 'Pepsi\u00AE Wild Cherry 12-Pack', price: 8.49, category: 'soft-drinks', flavor: 'Wild Cherry' },
  { id: 'MTD-CLS-12', name: 'Mountain Dew\u00AE 12-Pack', price: 7.99, category: 'soft-drinks', flavor: 'Citrus' },
  { id: 'STARRY-LL-12', name: 'STARRY\u2122 Lemon Lime 12-Pack', price: 7.99, category: 'soft-drinks', flavor: 'Lemon-Lime' },
  { id: 'PEP-GLS-BTL', name: 'Pepsi\u00AE Throwback Glass Bottle Set (6 ct)', price: 18.95, category: 'collectibles', flavor: 'Cola' },
  { id: 'PEP-TEE-PL', name: 'Pepsi\u00AE Globe Logo Tee', price: 22.95, category: 'merchandise', flavor: 'N/A' },
];

/**
 * Tax region configuration
 */
const TAX_REGIONS = {
  US: { taxRate: 0.08, currency: 'USD' },
  EU: { taxRate: 0.20, currency: 'EUR' },
  UK: { taxRate: 0.20, currency: 'GBP' },
  CA: { taxRate: 0.13, currency: 'CAD' },
};

/**
 * Active promotions — "Pepsi Challenge" loyalty campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-CHALLENGE-2026', name: 'Pepsi Challenge\u2122 Reward', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 50) return { rate: 0.15, label: '15% off orders $50+' };
  if (subtotal >= 30) return { rate: 0.10, label: '10% off orders $30+' };
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
 * BUG: PROMO-CHALLENGE-2026 is not in CATALOG, so product.name crashes.
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
 * Processes a Pepsi Shop e-commerce checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Pepsi checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'pepsi-ecommerce',
    route: '/api/12b28f14/checkout',
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
      route: '/api/12b28f14/checkout',
      source: 'pepsi-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/12b28f14/checkout',
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
      route: '/api/12b28f14/checkout',
      errorClass: error.name,
      source: 'pepsi-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/12b28f14/checkout',
      error: 'true',
    });

    logger.error('Pepsi checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'pepsi-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/12b28f14/checkout',
        service: 'pepsi-ecommerce',
        source: 'pepsi-storefront',
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
      culprit: 'app/services/verticals/12b28f14.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'pepsi-ecommerce',
      verticalLabel: 'Pepsi Checkout',
      customer: '12b28f14',
      tags: [
        { key: 'route', value: '/api/12b28f14/checkout' },
        { key: 'service', value: 'pepsi-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'pepsi-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Pepsi checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
