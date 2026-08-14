const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * EA app storefront catalog — games and subscription editions
 */
const CATALOG = [
  { id: 'EA-MADDEN27-DLX', title: 'Madden NFL 27 Deluxe Edition', platform: 'PC', edition: 'deluxe', price: 99.99 },
  { id: 'EA-FC26-STD', title: 'EA SPORTS FC 26 Standard Edition', platform: 'PC', edition: 'standard', price: 69.99 },
  { id: 'EA-BF6-STD', title: 'Battlefield 6 Standard Edition', platform: 'PC', edition: 'standard', price: 69.99 },
  { id: 'EA-SIMS4-EXP', title: 'The Sims 4 Expansion Bundle', platform: 'PC', edition: 'bundle', price: 39.99 },
  { id: 'EA-APEX-COINS', title: 'Apex Legends 2150 Coins', platform: 'PC', edition: 'currency', price: 19.99 },
  { id: 'EA-PLAY-PRO-12M', title: 'EA Play Pro — 12 Month Membership', platform: 'PC', edition: 'membership', price: 119.99 },
  { id: 'EA-PLAY-12M', title: 'EA Play — 12 Month Membership', platform: 'PC', edition: 'membership', price: 39.99 },
];

/**
 * Storefront region configuration — tax rate + billing currency per market
 */
const STOREFRONT_REGIONS = {
  US: { taxRate: 0.0875, currency: 'USD' },
  UK: { taxRate: 0.20, currency: 'GBP' },
  DE: { taxRate: 0.19, currency: 'EUR' },
  JP: { taxRate: 0.10, currency: 'JPY' },
};

/**
 * Active entitlements granted at purchase time — the EA Play member reward
 * is attached server-side so it shows up on the order summary.
 */
const ACTIVE_ENTITLEMENTS = [
  { sku: 'PROMO-EAPLAY-REWARD-2026', title: 'EA Play Member Reward Pack', price: 0, qty: 1 },
];

/**
 * Looks up the EA Play member discount for a given cart subtotal.
 */
function getMemberDiscount(subtotal) {
  if (subtotal >= 150) return { rate: 0.15, label: '15% EA Play Pro member savings on orders $150+' };
  if (subtotal >= 75) return { rate: 0.10, label: '10% EA Play member savings on orders $75+' };
  return { rate: 0, label: 'None' };
}

/**
 * Merges member entitlements into the cart line items.
 */
function applyEntitlements(items) {
  return [...items, ...ACTIVE_ENTITLEMENTS];
}

/**
 * Computes the final order charges.
 */
function computeOrderCharges(subtotal, region) {
  const regionConfig = STOREFRONT_REGIONS[region];
  if (!regionConfig) {
    throw Object.assign(new Error(`Unknown storefront region: ${region}`), { code: 'INVALID_REGION' });
  }
  const tax = subtotal * regionConfig.taxRate;
  const discount = getMemberDiscount(subtotal);
  const discountAmount = (subtotal + tax) * discount.rate;
  return {
    subtotal,
    tax: Math.round(tax * 100) / 100,
    discount: Math.round(discountAmount * 100) / 100,
    discountLabel: discount.label,
    total: Math.round((subtotal + tax - discountAmount) * 100) / 100,
    currency: regionConfig.currency,
  };
}

/**
 * Formats the order summary for the purchase confirmation.
 * BUG: PROMO-EAPLAY-REWARD-2026 is not in CATALOG, so product.title crashes.
 */
function formatOrder(allItems) {
  return allItems.map((item) => {
    const product = CATALOG.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      title: product.title,
      platform: product.platform,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * Processes an EA app storefront purchase.
 */
async function processPurchase(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing EA storefront purchase', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'ea-storefront',
    route: '/api/bc6a7c34/purchase',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyEntitlements(orderData.items);

    const computedSubtotal = allItems.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    ) || orderData.subtotal;

    const finalSubtotal = typeof computedSubtotal === 'string'
      ? parseFloat(computedSubtotal)
      : computedSubtotal;

    const result = computeOrderCharges(finalSubtotal, orderData.region);
    const summary = formatOrder(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/bc6a7c34/purchase',
      source: 'ea-app',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/bc6a7c34/purchase',
    });

    return {
      success: true,
      orderId,
      total: result.total,
      tax: result.tax,
      discount: result.discount,
      discountLabel: result.discountLabel,
      summary,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/bc6a7c34/purchase',
      errorClass: error.name,
      source: 'ea-app',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/bc6a7c34/purchase',
      error: 'true',
    });

    logger.error('EA storefront purchase failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'ea-storefront',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/bc6a7c34/purchase',
        service: 'ea-storefront',
        source: 'ea-app',
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
      culprit: 'app/services/verticals/bc6a7c34.js \u2014 formatOrder',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'bc6a7c34',
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'ea-storefront',
      verticalLabel: 'EA Storefront Purchase',
      tags: [
        { key: 'route', value: '/api/bc6a7c34/purchase' },
        { key: 'service', value: 'ea-storefront' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'ea-storefront@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from EA purchase error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processPurchase, computeOrderCharges, formatOrder, applyEntitlements, CATALOG, STOREFRONT_REGIONS };
