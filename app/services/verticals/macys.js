const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Macy's product catalog — department store SKUs
 */
const CATALOG = [
  { id: 'MCY-INC-DRS', name: 'INC International Concepts Sequined Dress', price: 119.50, category: 'womens-dresses', form: 'Apparel' },
  { id: 'MCY-CC-SWT', name: 'Charter Club Cashmere Sweater', price: 89.50, category: 'womens-sweaters', form: 'Apparel' },
  { id: 'MCY-RL-POLO', name: 'Polo Ralph Lauren Classic Fit Polo', price: 98.00, category: 'mens-tops', form: 'Apparel' },
  { id: 'MCY-MK-TOTE', name: 'Michael Kors Jet Set Leather Tote', price: 298.00, category: 'handbags', form: 'Accessory' },
  { id: 'MCY-CLQ-SET', name: 'Clinique 3-Step Skincare Gift Set', price: 49.50, category: 'beauty', form: 'Beauty' },
  { id: 'MCY-HC-DUVET', name: 'Hotel Collection Cotton Duvet Cover', price: 220.00, category: 'home-bedding', form: 'Home' },
  { id: 'MCY-TH-JEANS', name: 'Tommy Hilfiger Straight Fit Jeans', price: 79.50, category: 'mens-jeans', form: 'Apparel' },
  { id: 'MCY-MAC-LIP', name: 'MAC Retro Matte Lipstick', price: 22.00, category: 'beauty', form: 'Beauty' },
];

/**
 * State-level tax configuration for store fulfillment
 */
const TAX_REGIONS = {
  NY: { taxRate: 0.08875, currency: 'USD' },
  CA: { taxRate: 0.0725, currency: 'USD' },
  FL: { taxRate: 0.06, currency: 'USD' },
  TX: { taxRate: 0.0625, currency: 'USD' },
};

/**
 * Active promotions — "Star Rewards Member bonus" campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-STARREWARDS-2026', name: 'Star Rewards Member Bonus', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 100) return { rate: 0.20, label: '20% off orders $100+' };
  if (subtotal >= 50) return { rate: 0.15, label: '15% off orders $50+' };
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
 * BUG: PROMO-STARREWARDS-2026 is not in CATALOG, so product.name crashes.
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
 * Processes a Macy's department store checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Macy\'s checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'macys-department-store',
    route: '/api/macys/checkout',
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
      route: '/api/macys/checkout',
      source: 'macys-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/macys/checkout',
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
      route: '/api/macys/checkout',
      errorClass: error.name,
      source: 'macys-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/macys/checkout',
      error: 'true',
    });

    logger.error('Macy\'s checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'macys-department-store',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/macys/checkout',
        service: 'macys-department-store',
        source: 'macys-storefront',
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
      culprit: 'app/services/verticals/macys.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'macys-department-store',
      verticalLabel: 'Macy\u2019s Checkout',
      tags: [
        { key: 'route', value: '/api/macys/checkout' },
        { key: 'service', value: 'macys-department-store' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'macys-department-store@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Macy\'s checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
