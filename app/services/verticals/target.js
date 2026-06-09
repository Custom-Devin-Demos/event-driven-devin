const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Target product catalog — general merchandise e-commerce SKUs
 */
const CATALOG = [
  { id: 'TGT-GG-COFFEE', name: 'Good & Gather\u2122 Medium Roast Coffee (12 oz)', price: 7.99, category: 'grocery', brand: 'Good & Gather' },
  { id: 'TGT-UU-PTOWEL', name: 'up & up\u2122 Paper Towels (6 Rolls)', price: 9.49, category: 'household', brand: 'up & up' },
  { id: 'TGT-CJ-TEE', name: 'Cat & Jack\u2122 Kids\u2019 Short Sleeve T-Shirt', price: 6.00, category: 'apparel', brand: 'Cat & Jack' },
  { id: 'TGT-THR-TOWEL', name: 'Threshold\u2122 Performance Bath Towel', price: 12.00, category: 'home', brand: 'Threshold' },
  { id: 'TGT-AD-CANDLE', name: 'A New Day\u2122 Lavender Soy Candle', price: 10.00, category: 'home', brand: 'A New Day' },
  { id: 'TGT-RM-HEADPH', name: 'heyday\u2122 Bluetooth Wireless Headphones', price: 29.99, category: 'electronics', brand: 'heyday' },
  { id: 'TGT-BE-BLENDER', name: 'Brightroom\u2122 Stackable Storage Bin', price: 8.00, category: 'home', brand: 'Brightroom' },
  { id: 'TGT-GG-OLIVEOIL', name: 'Good & Gather\u2122 Extra Virgin Olive Oil (17 oz)', price: 8.49, category: 'grocery', brand: 'Good & Gather' },
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
 * Active promotions — "Target Circle exclusive" campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-CIRCLE-2026', name: 'Target Circle\u2122 Reward', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 50) return { rate: 0.15, label: '15% off orders $50+' };
  if (subtotal >= 35) return { rate: 0.10, label: '10% off orders $35+' };
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
 * BUG: PROMO-CIRCLE-2026 is not in CATALOG, so product.name crashes.
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
 * Processes a Target e-commerce checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Target checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'target-ecommerce',
    route: '/api/target/checkout',
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
      route: '/api/target/checkout',
      source: 'target-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/target/checkout',
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
      route: '/api/target/checkout',
      errorClass: error.name,
      source: 'target-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/target/checkout',
      error: 'true',
    });

    logger.error('Target checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'target-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/target/checkout',
        service: 'target-ecommerce',
        source: 'target-storefront',
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
      culprit: 'app/services/verticals/target.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'target-ecommerce',
      verticalLabel: 'Target Checkout',
      tags: [
        { key: 'route', value: '/api/target/checkout' },
        { key: 'service', value: 'target-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'target-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Target checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
