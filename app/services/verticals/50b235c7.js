const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * lululemon product catalog — technical apparel SKUs
 */
const CATALOG = [
  { id: 'LLL-ALIGN-25', name: 'Align\u2122 High-Rise Pant 25"', price: 98.00, category: 'womens-bottoms', colour: 'Black' },
  { id: 'LLL-WTRAIN-28', name: 'Wunder Train High-Rise Tight 28"', price: 108.00, category: 'womens-bottoms', colour: 'True Navy' },
  { id: 'LLL-DEFINE-JK', name: 'Define Jacket Luon\u2122', price: 128.00, category: 'womens-outerwear', colour: 'Heathered Core Ultra Light Grey' },
  { id: 'LLL-SCUBA-HD', name: 'Scuba Oversized Full-Zip Hoodie', price: 118.00, category: 'womens-outerwear', colour: 'Heathered Java' },
  { id: 'LLL-ABC-JOG', name: 'ABC Jogger Warpstreme\u2122', price: 128.00, category: 'mens-bottoms', colour: 'Obsidian' },
  { id: 'LLL-ABC-CLS', name: 'ABC Classic-Fit Trouser 32"L', price: 128.00, category: 'mens-bottoms', colour: 'True Navy' },
  { id: 'LLL-MVT-SS', name: 'Metal Vent Tech Short-Sleeve Shirt', price: 78.00, category: 'mens-tops', colour: 'Graphite Grey' },
  { id: 'LLL-BELT-1L', name: 'Everywhere Belt Bag 1L', price: 38.00, category: 'accessories', colour: 'Black' },
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
 * Active promotions — "lululemon Studio Member exclusive" campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-STUDIO-2026', name: 'lululemon Studio Member Gift', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 250) return { rate: 0.15, label: '15% off orders $250+' };
  if (subtotal >= 150) return { rate: 0.10, label: '10% off orders $150+' };
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
 * BUG: PROMO-STUDIO-2026 is not in CATALOG, so product.name crashes.
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
 * Processes a lululemon e-commerce checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing lululemon checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'lululemon-ecommerce',
    route: '/api/50b235c7/checkout',
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
      route: '/api/50b235c7/checkout',
      source: 'lululemon-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/50b235c7/checkout',
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
      route: '/api/50b235c7/checkout',
      errorClass: error.name,
      source: 'lululemon-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/50b235c7/checkout',
      error: 'true',
    });

    logger.error('lululemon checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'lululemon-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/50b235c7/checkout',
        service: 'lululemon-ecommerce',
        source: 'lululemon-storefront',
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
      culprit: 'app/services/verticals/50b235c7.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'lululemon-ecommerce',
      verticalLabel: 'lululemon Checkout',
      tags: [
        { key: 'route', value: '/api/50b235c7/checkout' },
        { key: 'service', value: 'lululemon-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'lululemon-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from lululemon checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
