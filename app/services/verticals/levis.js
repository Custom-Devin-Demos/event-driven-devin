const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Levi's product catalog — consumer e-commerce SKUs
 */
const CATALOG = [
  { id: 'LEV-501-OG', name: "501\u00AE Original Fit Jeans", price: 69.50, category: 'mens-jeans', wash: 'Medium Indigo' },
  { id: 'LEV-511-SL', name: "511\u2122 Slim Fit Jeans", price: 69.50, category: 'mens-jeans', wash: 'Clean Dark' },
  { id: 'LEV-512-TP', name: "512\u2122 Slim Taper Fit Jeans", price: 79.50, category: 'mens-jeans', wash: 'Headed South' },
  { id: 'LEV-505-RG', name: "505\u2122 Regular Fit Jeans", price: 59.50, category: 'mens-jeans', wash: 'Medium Stonewash' },
  { id: 'LEV-721-HR', name: "721\u2122 High Rise Skinny Jeans", price: 69.50, category: 'womens-jeans', wash: 'Blue Story' },
  { id: 'LEV-501-CR', name: "501\u00AE Original Cropped Jeans", price: 79.50, category: 'womens-jeans', wash: 'Ojai Luxor' },
  { id: 'LEV-TRK-JK', name: "Trucker Jacket", price: 89.50, category: 'outerwear', wash: 'Medium Wash' },
  { id: 'LEV-EX-BF', name: "Ex-Boyfriend Trucker Jacket", price: 98.00, category: 'womens-outerwear', wash: 'Concrete Indigo' },
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
 * Active promotions — "Red Tab Member exclusive" campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-REDTAB-2026', name: 'Red Tab\u2122 Member Gift', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 150) return { rate: 0.15, label: '15% off orders $150+' };
  if (subtotal >= 100) return { rate: 0.10, label: '10% off orders $100+' };
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
 * BUG: PROMO-REDTAB-2026 is not in CATALOG, so product.name crashes.
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
 * Processes a Levi's e-commerce checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Levi\'s checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'levis-ecommerce',
    route: '/api/levis/checkout',
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
      route: '/api/levis/checkout',
      source: 'levis-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/levis/checkout',
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
      route: '/api/levis/checkout',
      errorClass: error.name,
      source: 'levis-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/levis/checkout',
      error: 'true',
    });

    logger.error('Levi\'s checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'levis-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/levis/checkout',
        service: 'levis-ecommerce',
        source: 'levis-storefront',
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
      culprit: 'app/services/verticals/levis.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'levis-ecommerce',
      verticalLabel: 'Levi\u2019s Checkout',
      tags: [
        { key: 'route', value: '/api/levis/checkout' },
        { key: 'service', value: 'levis-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'levis-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Levi\'s checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
