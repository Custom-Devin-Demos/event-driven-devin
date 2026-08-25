const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Chewy shopping cart catalog. Prices in USD, matching the chewy.com
 * cart experience.
 */
const PRODUCTS = [
  {
    id: 'LWR-PFC-BEEF-24OZ',
    brand: 'Lone Wolf Ranch',
    name: 'Power Foods Complete Beef Air-Dried Dog Food, 24-oz bag',
    listPrice: 42.99,
    price: 42.99,
    category: 'Dog Food',
    autoshipRate: 0.35,
    promoCode: 'WELCOME',
  },
  {
    id: 'BB-WLD-SALMON-24LB',
    brand: 'Blue Bay',
    name: 'Wilderness Salmon Recipe Grain-Free Dry Dog Food, 24-lb bag',
    listPrice: 64.98,
    price: 59.98,
    category: 'Dog Food',
    autoshipRate: 0.05,
    promoCode: 'AUTOSHIP20',
  },
  {
    id: 'TC-CHKN-PATE-24PK',
    brand: 'Tiny Chef',
    name: 'Chicken Pate Grain-Free Canned Cat Food, 3-oz, case of 24',
    listPrice: 32.48,
    price: 28.99,
    category: 'Cat Food',
    autoshipRate: 0.05,
    promoCode: 'FREESHIP',
  },
];

/**
 * eGift-card promotions the merchandising service exposes to the cart.
 * Keyed by the promo code stamped on each catalog item.
 */
const EGIFT_PROMOTIONS = {
  AUTOSHIP20: { eGiftAmount: 20, minSpend: 49, freeShipping: false, label: 'Autoship savings' },
  FREESHIP: { eGiftAmount: 0, minSpend: 35, freeShipping: true, label: 'Free shipping' },
};

/**
 * Autoship program: percentage off the first order, then a standing
 * discount on every recurring delivery.
 */
const AUTOSHIP_FUTURE_RATE = 0.1;

/**
 * Free-shipping ("Your order ships FREE!") threshold in USD.
 */
const FREE_SHIPPING_THRESHOLD = 49;
const STANDARD_SHIPPING = 6.95;

/**
 * Build the cart line items from the incoming SKUs.
 */
function buildLineItems(items) {
  return items.map((item) => {
    const product = PRODUCTS.find((p) => p.id === item.sku);
    if (!product) return null;
    const qty = item.qty || 1;
    return {
      sku: product.id,
      brand: product.brand,
      name: product.name,
      qty,
      unitPrice: product.price,
      listPrice: product.listPrice,
      autoshipRate: product.autoshipRate,
      promoCode: product.promoCode,
    };
  }).filter(Boolean);
}

/**
 * Resolve the eGift-card reward the cart qualifies for across all lines.
 */
function resolveEGiftReward(lineItems, merchandiseTotal) {
  return lineItems.reduce((reward, li) => {
    const promotion = EGIFT_PROMOTIONS[li.promoCode];
    if (merchandiseTotal < promotion.minSpend) return reward;
    return {
      eGiftAmount: reward.eGiftAmount + promotion.eGiftAmount,
      freeShipping: reward.freeShipping || promotion.freeShipping,
      labels: reward.labels.concat(promotion.label),
    };
  }, { eGiftAmount: 0, freeShipping: false, labels: [] });
}

/**
 * Compute the cart summary shown in the order-summary rail: subtotal,
 * Autoship savings, shipping and estimated total.
 */
function computeCartSummary(lineItems, autoship) {
  const subtotal = lineItems.reduce((sum, li) => sum + li.unitPrice * li.qty, 0);

  const autoshipSavings = autoship
    ? lineItems.reduce((sum, li) => sum + li.unitPrice * li.qty * li.autoshipRate, 0)
    : 0;

  const merchandiseTotal = subtotal - autoshipSavings;
  const reward = resolveEGiftReward(lineItems, merchandiseTotal);

  const shipping = reward.freeShipping || merchandiseTotal >= FREE_SHIPPING_THRESHOLD
    ? 0
    : STANDARD_SHIPPING;

  const round = (n) => Math.round(n * 100) / 100;

  return {
    itemCount: lineItems.reduce((sum, li) => sum + li.qty, 0),
    subtotal: round(subtotal),
    autoshipSavings: round(autoshipSavings),
    futureOrderRate: AUTOSHIP_FUTURE_RATE,
    shipping: round(shipping),
    eGiftAmount: reward.eGiftAmount,
    promotions: reward.labels,
    total: round(merchandiseTotal + shipping),
    currency: 'USD',
  };
}

/**
 * Process a Chewy cart checkout ("Proceed to Checkout").
 */
async function processCheckout(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Chewy cart checkout', {
    orderId,
    itemCount: data.items ? data.items.length : 0,
    autoship: Boolean(data.autoship),
    service: 'chewy-cart',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 120));

    const lineItems = buildLineItems(data.items || []);
    if (lineItems.length === 0) {
      const err = new Error('Your cart is empty. Add at least one item to continue.');
      err.name = 'EmptyCartError';
      err.code = 'EMPTY_CART';
      throw err;
    }

    const summary = computeCartSummary(lineItems, Boolean(data.autoship));

    const duration = Date.now() - startTime;
    incrementMetric('chewy_checkout.success', { route: '/api/chewy/checkout' });
    recordTiming('chewy_checkout.latency', duration, { route: '/api/chewy/checkout' });

    return {
      success: true,
      orderId,
      items: lineItems,
      ...summary,
      autoship: Boolean(data.autoship),
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('chewy_checkout.failure', { route: '/api/chewy/checkout', errorClass: error.name });
    recordTiming('chewy_checkout.latency', duration, { route: '/api/chewy/checkout', error: 'true' });
    logger.error('Chewy cart checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });
    Sentry.captureException(error, {
      tags: {
        route: '/api/chewy/checkout',
        service: 'chewy-cart',
      },
      extra: { orderId, itemCount: data.items ? data.items.length : 0 },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/chewy.js \u2014 resolveEGiftReward',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      service: 'chewy-cart',
      verticalLabel: 'Chewy Shopping Cart',
      customer: 'chewy',
      tags: [
        { key: 'route', value: '/api/chewy/checkout' },
        { key: 'service', value: 'chewy-cart' },
      ],
      extra: { orderId, itemCount: data.items ? data.items.length : 0 },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'chewy-cart@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from Chewy checkout error', { error: alertError.message });
    });
    throw error;
  }
}

module.exports = { processCheckout, PRODUCTS, EGIFT_PROMOTIONS };
