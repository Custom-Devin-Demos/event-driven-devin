const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Gap product catalog — apparel e-commerce SKUs
 */
const CATALOG = [
  { id: 'GAP-VS-HOODIE', name: 'Vintage Soft Arch Logo Hoodie', price: 59.95, category: 'apparel', brand: 'Gap' },
  { id: 'GAP-90S-JEAN', name: '90s Loose Jeans in Washed Indigo', price: 79.95, category: 'apparel', brand: 'Gap' },
  { id: 'GAP-MC-TEE', name: 'Modern Crewneck T-Shirt', price: 19.95, category: 'apparel', brand: 'Gap' },
  { id: 'GAP-DEN-JACKET', name: 'Icon Denim Jacket', price: 89.95, category: 'apparel', brand: 'Gap' },
  { id: 'GAP-KH-CHINO', name: 'Modern Khakis in Slim Fit', price: 69.95, category: 'apparel', brand: 'Gap' },
  { id: 'GAP-CB-SWEATER', name: 'CashSoft Crewneck Sweater', price: 64.95, category: 'apparel', brand: 'Gap' },
  { id: 'GAP-LG-LEGGING', name: 'GapFit High Rise Leggings', price: 49.95, category: 'activewear', brand: 'GapFit' },
  { id: 'GAP-BB-BODYSUIT', name: 'babyGap Organic Cotton Bodysuit (3-Pack)', price: 24.95, category: 'baby', brand: 'babyGap' },
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
 * Active promotions — "Gap Good Rewards" campaign.
 * Applied server-side so it appears in the order confirmation.
 */
const ACTIVE_PROMOTIONS = [
  { sku: 'PROMO-GOODREWARDS-2026', name: 'Gap Good Rewards Bonus', price: 0, qty: 1 },
];

/**
 * Looks up the discount tier for a given subtotal.
 */
function getApplicableDiscount(subtotal) {
  if (subtotal >= 100) return { rate: 0.20, label: '20% off orders $100+' };
  if (subtotal >= 50) return { rate: 0.10, label: '10% off orders $50+' };
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
 * BUG: PROMO-GOODREWARDS-2026 is not in CATALOG, so product.name crashes.
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
 * Processes a Gap e-commerce checkout order.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Gap checkout', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'gap-ecommerce',
    route: '/api/43f2f084/checkout',
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
      route: '/api/43f2f084/checkout',
      source: 'gap-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/43f2f084/checkout',
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
      route: '/api/43f2f084/checkout',
      errorClass: error.name,
      source: 'gap-storefront',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/43f2f084/checkout',
      error: 'true',
    });

    logger.error('Gap checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'gap-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/43f2f084/checkout',
        service: 'gap-ecommerce',
        source: 'gap-storefront',
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
      customer: '43f2f084',
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/43f2f084.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'gap-ecommerce',
      verticalLabel: 'Gap Checkout',
      tags: [
        { key: 'route', value: '/api/43f2f084/checkout' },
        { key: 'service', value: 'gap-ecommerce' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'gap-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Gap checkout error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processCheckout, computeOrderTotal, formatReceipt, applyPromotions, CATALOG, TAX_REGIONS };
