const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Timberland product catalog — consumer e-commerce SKUs
 */
const CATALOG = [
  { id: 'TBL-PREM-6IN', name: 'Premium 6-Inch Waterproof Boots', price: 228.00, category: 'mens-boots', colorway: 'Wheat Nubuck' },
  { id: 'TBL-FIELD-BT', name: 'Field Boots', price: 200.00, category: 'mens-boots', colorway: 'Brown / Olive' },
  { id: 'TBL-BOAT-3EY', name: 'Authentic 3-Eye Classic Boat Shoe', price: 135.00, category: 'mens-shoes', colorway: 'Burgundy Full-Grain' },
  { id: 'TBL-PREM-6W', name: "Women's Premium 6-Inch Boots", price: 228.00, category: 'womens-boots', colorway: 'Wheat Nubuck' },
  { id: 'TBL-STONE-ST', name: 'Stone Street Chelsea Boots', price: 180.00, category: 'mens-boots', colorway: 'Dark Brown' },
  { id: 'TBL-RDWD-LO', name: 'Redwood Falls Low Hikers', price: 110.00, category: 'mens-shoes', colorway: 'Wheat' },
  { id: 'TBL-LINEN-SS', name: 'Linen-Blend Short Sleeve Shirt', price: 65.00, category: 'apparel', colorway: 'Cassel Earth' },
  { id: 'TBL-CHINO-SH', name: 'Stretch Twill Chino Shorts', price: 55.00, category: 'apparel', colorway: 'Burnt Olive' },
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
 * Active promotions — "Timberland Community member" 4th of July campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-JULY4-2026', name: '4th of July Member Gift', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 300) return { rate: 0.20, label: '20% off orders $300+' };
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
 * BUG: PROMO-JULY4-2026 is not in CATALOG, so product.name crashes.
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
 * Processes a Timberland e-commerce checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Timberland checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'timberland-ecommerce',
    route: '/api/timberland/checkout',
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
      route: '/api/timberland/checkout',
      source: 'timberland-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/timberland/checkout',
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
      route: '/api/timberland/checkout',
      errorClass: error.name,
      source: 'timberland-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/timberland/checkout',
      error: 'true',
    });

    logger.error('Timberland checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'timberland-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/timberland/checkout',
        service: 'timberland-ecommerce',
        source: 'timberland-storefront',
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
      culprit: 'app/services/verticals/timberland.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'timberland',
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'timberland-ecommerce',
      verticalLabel: 'Timberland Checkout',
      tags: [
        { key: 'route', value: '/api/timberland/checkout' },
        { key: 'service', value: 'timberland-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'timberland-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Timberland checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
