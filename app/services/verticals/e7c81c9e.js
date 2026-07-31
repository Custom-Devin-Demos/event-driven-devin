const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Nordstrom product catalog — apparel & accessories SKUs
 */
const CATALOG = [
  { id: 'NRD-ZEL-CSH', name: 'Zella Cashmere Blend Crewneck Sweater', price: 129.00, category: 'womens-apparel', color: 'Grey Heather' },
  { id: 'NRD-VNC-BLZ', name: 'Vince Wool Blend Blazer', price: 495.00, category: 'womens-apparel', color: 'Black' },
  { id: 'NRD-NDS-OXF', name: 'Nordstrom Trim Fit Oxford Shirt', price: 89.50, category: 'mens-apparel', color: 'White' },
  { id: 'NRD-BOSS-CHN', name: 'BOSS Slim Fit Stretch Chinos', price: 148.00, category: 'mens-apparel', color: 'Navy' },
  { id: 'NRD-UGG-SLP', name: 'UGG\u00AE Tasman Slipper', price: 110.00, category: 'shoes', color: 'Chestnut' },
  { id: 'NRD-SAM-MUL', name: 'Sam Edelman Loraine Loafer Mule', price: 150.00, category: 'shoes', color: 'Cognac Leather' },
  { id: 'NRD-MDW-TOT', name: 'Madewell Transport Leather Tote', price: 178.00, category: 'handbags', color: 'True Black' },
  { id: 'NRD-BRB-SET', name: 'Barefoot Dreams\u00AE CozyChic Throw', price: 147.00, category: 'home', color: 'Cream Stone' },
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
 * Active promotions — "Nordy Club member exclusive" campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-NORDYCLUB-2026', name: 'Nordy Club Bonus Points Gift', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 400) return { rate: 0.15, label: '15% off orders $400+' };
  if (subtotal >= 250) return { rate: 0.10, label: '10% off orders $250+' };
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
 * BUG: PROMO-NORDYCLUB-2026 is not in CATALOG, so product.name crashes.
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
 * Processes a Nordstrom e-commerce checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Nordstrom checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'nordstrom-ecommerce',
    route: '/api/e7c81c9e/checkout',
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
      route: '/api/e7c81c9e/checkout',
      source: 'nordstrom-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/e7c81c9e/checkout',
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
      route: '/api/e7c81c9e/checkout',
      errorClass: error.name,
      source: 'nordstrom-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/e7c81c9e/checkout',
      error: 'true',
    });

    logger.error('Nordstrom checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'nordstrom-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/e7c81c9e/checkout',
        service: 'nordstrom-ecommerce',
        source: 'nordstrom-storefront',
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
      culprit: 'app/services/verticals/e7c81c9e.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'e7c81c9e',
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'nordstrom-ecommerce',
      verticalLabel: 'Nordstrom Checkout',
      tags: [
        { key: 'route', value: '/api/e7c81c9e/checkout' },
        { key: 'service', value: 'nordstrom-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'nordstrom-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Nordstrom checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
