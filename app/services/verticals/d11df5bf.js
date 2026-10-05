const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * P&G product catalog — direct-to-consumer household & personal care SKUs
 */
const CATALOG = [
  { id: 'PG-TIDE-PODS-81', name: 'Tide PODS\u00AE Original Laundry Detergent Pacs', price: 26.99, category: 'fabric-care', brand: 'Tide', size: '81 ct' },
  { id: 'PG-PAMP-SWD-4', name: 'Pampers\u00AE Swaddlers\u2122 Diapers', price: 49.99, category: 'baby-care', brand: 'Pampers', size: 'Size 4 \u00B7 150 ct' },
  { id: 'PG-GIL-FG5-8', name: 'Gillette\u00AE Fusion5\u2122 Razor Blade Refills', price: 39.99, category: 'grooming', brand: 'Gillette', size: '8 ct' },
  { id: 'PG-OLAY-RGN-MW', name: 'Olay Regenerist Micro-Sculpting Cream', price: 32.99, category: 'skin-care', brand: 'Olay', size: '1.7 oz' },
  { id: 'PG-CREST-3DW-4', name: 'Crest 3D White Toothpaste', price: 15.49, category: 'oral-care', brand: 'Crest', size: '4-pack' },
  { id: 'PG-ORALB-IO5', name: 'Oral-B iO Series 5 Electric Toothbrush', price: 99.99, category: 'oral-care', brand: 'Oral-B', size: '1 handle' },
  { id: 'PG-BOUNTY-SAS-12', name: 'Bounty\u00AE Select-A-Size Paper Towels', price: 31.99, category: 'family-care', brand: 'Bounty', size: '12 Double Rolls' },
  { id: 'PG-CHARM-UST-18', name: 'Charmin\u00AE Ultra Strong Toilet Paper', price: 27.99, category: 'family-care', brand: 'Charmin', size: '18 Mega Rolls' },
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
 * Active promotions — "P&G Good Everyday" member campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-GOODEVERYDAY-2026', name: 'P&G Good Everyday Free Sample Kit', price: 0, qty: 1 },
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
 * BUG: PROMO-GOODEVERYDAY-2026 is not in CATALOG, so product.name crashes.
 */
function formatReceipt(allItems) {
  return allItems.map((item) => {
    const product = CATALOG.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: product.name,
      brand: product.brand,
      category: product.category,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * Processes a P&G direct-to-consumer checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing P&G checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'pg-ecommerce',
    route: '/api/d11df5bf/checkout',
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
      route: '/api/d11df5bf/checkout',
      source: 'pg-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/d11df5bf/checkout',
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
      route: '/api/d11df5bf/checkout',
      errorClass: error.name,
      source: 'pg-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/d11df5bf/checkout',
      error: 'true',
    });

    logger.error('P&G checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'pg-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/d11df5bf/checkout',
        service: 'pg-ecommerce',
        source: 'pg-storefront',
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
      culprit: 'app/services/verticals/d11df5bf.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'pg-ecommerce',
      verticalLabel: 'P&G Shop Checkout',
      tags: [
        { key: 'route', value: '/api/d11df5bf/checkout' },
        { key: 'service', value: 'pg-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'pg-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from P&G checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
