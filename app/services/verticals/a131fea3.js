const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * O'Reilly Auto Parts catalog — automotive parts & accessories SKUs
 */
const CATALOG = [
  { id: 'MP-HC1', name: 'MasterPro 7/16" to 5/8" Hose Clamp', price: 4.99, category: 'belts-hoses', brand: 'MasterPro' },
  { id: 'MG-OF45', name: 'Microgard Spin-On Engine Oil Filter', price: 8.99, category: 'filters', brand: 'Microgard' },
  { id: 'SS-BAT24F', name: 'SuperStart Extreme 24F Battery', price: 189.99, category: 'batteries', brand: 'SuperStart' },
  { id: 'BB-BP102', name: 'BrakeBest Select Ceramic Brake Pads', price: 42.99, category: 'brakes', brand: 'BrakeBest' },
  { id: 'OR-WB22', name: "O'Reilly 22\" Premium Wiper Blade", price: 14.99, category: 'wipers', brand: "O'Reilly" },
  { id: 'MUR-SP6', name: 'Murray Copper Spark Plug (6-Pack)', price: 19.99, category: 'ignition', brand: 'Murray' },
  { id: 'MG-AF31', name: 'Microgard Engine Air Filter', price: 16.99, category: 'filters', brand: 'Microgard' },
  { id: 'MP-SYN5', name: 'MasterPro Full Synthetic 5W-30 (5 qt)', price: 27.99, category: 'oil-fluids', brand: 'MasterPro' },
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
 * Active promotions — "O'Reilly Rewards member" parts bonus campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-OREWARDS-2026', name: 'O\'Reilly Rewards Member Gift', price: 0, qty: 1 },
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
 * BUG: PROMO-OREWARDS-2026 is not in CATALOG, so product.name crashes.
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
 * Processes an O'Reilly Auto Parts checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing O\'Reilly checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'oreilly-ecommerce',
    route: '/api/a131fea3/checkout',
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
      route: '/api/a131fea3/checkout',
      source: 'oreilly-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/a131fea3/checkout',
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
      route: '/api/a131fea3/checkout',
      errorClass: error.name,
      source: 'oreilly-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/a131fea3/checkout',
      error: 'true',
    });

    logger.error('O\'Reilly checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'oreilly-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/a131fea3/checkout',
        service: 'oreilly-ecommerce',
        source: 'oreilly-storefront',
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
      culprit: 'app/services/verticals/a131fea3.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'oreilly-ecommerce',
      verticalLabel: "O'Reilly Auto Parts Checkout",
      tags: [
        { key: 'route', value: '/api/a131fea3/checkout' },
        { key: 'service', value: 'oreilly-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'oreilly-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from O\'Reilly checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
