const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Coca-Cola Store product catalog — consumer e-commerce SKUs
 */
const CATALOG = [
  { id: 'COKE-CLS-12', name: 'Coca-Cola\u00AE Classic 12-Pack (12 fl oz)', price: 8.49, category: 'soft-drinks', flavor: 'Original Taste' },
  { id: 'COKE-ZER-12', name: 'Coca-Cola\u00AE Zero Sugar 12-Pack', price: 8.49, category: 'soft-drinks', flavor: 'Zero Sugar' },
  { id: 'COKE-DIET-12', name: 'Diet Coke\u00AE 12-Pack', price: 8.49, category: 'soft-drinks', flavor: 'Diet' },
  { id: 'COKE-CHRY-12', name: 'Coca-Cola\u00AE Cherry 12-Pack', price: 8.99, category: 'soft-drinks', flavor: 'Cherry' },
  { id: 'SPRT-LL-12', name: 'Sprite\u00AE Lemon-Lime 12-Pack', price: 8.49, category: 'soft-drinks', flavor: 'Lemon-Lime' },
  { id: 'FANT-OR-12', name: 'Fanta\u00AE Orange 12-Pack', price: 8.49, category: 'soft-drinks', flavor: 'Orange' },
  { id: 'COKE-GLS-BTL', name: 'Coca-Cola\u00AE Contour Glass Bottle Set (6 ct)', price: 19.95, category: 'collectibles', flavor: 'Original Taste' },
  { id: 'COKE-BEAR-PL', name: 'Coca-Cola\u00AE Polar Bear Plush', price: 24.95, category: 'merchandise', flavor: 'N/A' },
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
 * Active promotions — "Coca-Cola Insiders exclusive" campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-INSIDERS-2026', name: 'Coca-Cola Insiders\u2122 Gift', price: 0, qty: 1 },
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
 * BUG: PROMO-INSIDERS-2026 is not in CATALOG, so product.name crashes.
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
 * Processes a Coca-Cola Store e-commerce checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Coca-Cola checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'cocacola-ecommerce',
    route: '/api/cocacola/checkout',
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
      route: '/api/cocacola/checkout',
      source: 'cocacola-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/cocacola/checkout',
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
      route: '/api/cocacola/checkout',
      errorClass: error.name,
      source: 'cocacola-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/cocacola/checkout',
      error: 'true',
    });

    logger.error('Coca-Cola checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'cocacola-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/cocacola/checkout',
        service: 'cocacola-ecommerce',
        source: 'cocacola-storefront',
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
      culprit: 'app/services/verticals/cocacola.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'cocacola-ecommerce',
      verticalLabel: 'Coca-Cola Checkout',
      tags: [
        { key: 'route', value: '/api/cocacola/checkout' },
        { key: 'service', value: 'cocacola-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'cocacola-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Coca-Cola checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
