const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/b66a0397/checkout';
const SERVICE = 'dsg-checkout';
const SLACK_MEMBER_ID = process.env.DICKS_SLACK_MEMBER_ID || '';

/**
 * DICK'S Sporting Goods product catalog — sellable SKUs.
 */
const CATALOG = [
  { id: 'DSG-NK-PEG41', name: "Nike Men's Pegasus 41 Running Shoes", brand: 'Nike', price: 140.00, category: 'footwear', variant: 'University Red/White \u00B7 Size 10' },
  { id: 'DSG-SPL-TF1K', name: 'Spalding TF-1000 Legacy Indoor Basketball', brand: 'Spalding', price: 64.99, category: 'team-sports', variant: "Official Size 29.5\u2033" },
  { id: 'DSG-CAL-NRG78', name: "CALIA Women's Energize 7/8 Leggings", brand: 'CALIA', price: 59.99, category: 'apparel', variant: 'Tangerine \u00B7 Size M' },
  { id: 'DSG-HF-32WM', name: 'Hydro Flask 32 oz. Wide Mouth Bottle', brand: 'Hydro Flask', price: 44.95, category: 'accessories', variant: 'Sage' },
  { id: 'DSG-UA-HOOD', name: "Under Armour Men's Rival Fleece Hoodie", brand: 'Under Armour', price: 55.00, category: 'apparel', variant: 'Black \u00B7 Size L' },
  { id: 'DSG-WIL-A2K', name: 'Wilson 2026 A2000 11.5\u2033 Infield Glove', brand: 'Wilson', price: 299.95, category: 'baseball', variant: 'Right Hand Throw' },
];

/**
 * Sales tax by ship-to state.
 */
const STATE_TAX = {
  PA: { rate: 0.06, name: 'Pennsylvania' },
  NY: { rate: 0.08875, name: 'New York' },
  OH: { rate: 0.0575, name: 'Ohio' },
  TX: { rate: 0.0625, name: 'Texas' },
  CA: { rate: 0.0725, name: 'California' },
};

const SHIPPING_METHODS = {
  standard: { label: 'Standard Shipping (5\u20137 business days)', cost: 8.99, freeOver: 65 },
  express: { label: 'Express Shipping (2 business days)', cost: 19.99, freeOver: null },
  pickup: { label: 'Free Store Pickup', cost: 0, freeOver: null },
};

/**
 * ScoreCard loyalty — points per dollar by member tier.
 */
const SCORECARD_TIERS = {
  member: { label: 'ScoreCard', pointsPerDollar: 1 },
  gold: { label: 'ScoreCard Gold', pointsPerDollar: 1.5 },
};

/**
 * Active "Gift with Purchase" campaigns for ScoreCard members. Appended
 * server-side so the free item appears on the order confirmation.
 */
const GIFT_WITH_PURCHASE = [
  { sku: 'GWP-SC-DUFFEL-26', name: 'ScoreCard Gold Gift: DSG Team Duffel', price: 0, qty: 1, minSubtotal: 250 },
];

function findProduct(sku) {
  return CATALOG.find((p) => p.id === sku);
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Adds any Gift with Purchase items the order qualifies for.
 */
function applyGiftWithPurchase(items, subtotal) {
  const gifts = GIFT_WITH_PURCHASE
    .filter((gift) => subtotal >= gift.minSubtotal)
    .map(({ sku, name, price, qty }) => ({ sku, name, price, qty }));
  return [...items, ...gifts];
}

function computeShipping(method, subtotal) {
  const config = SHIPPING_METHODS[method];
  if (config.freeOver !== null && subtotal >= config.freeOver) return 0;
  return config.cost;
}

/**
 * Computes the order totals.
 */
function computeOrderTotal(subtotal, state, shippingMethod) {
  const tax = subtotal * STATE_TAX[state].rate;
  const shipping = computeShipping(shippingMethod, subtotal);
  return {
    subtotal: roundCents(subtotal),
    tax: roundCents(tax),
    shipping: roundCents(shipping),
    total: roundCents(subtotal + tax + shipping),
    currency: 'USD',
  };
}

function computeScoreCardPoints(subtotal, tier) {
  return Math.floor(subtotal * SCORECARD_TIERS[tier].pointsPerDollar);
}

/**
 * Builds the receipt lines shown on the order confirmation.
 */
function formatReceipt(allItems) {
  return allItems.map((item) => {
    const product = findProduct(item.sku);
    return {
      sku: item.sku,
      name: product.name,
      brand: product.brand,
      category: product.category,
      qty: item.qty,
      lineTotal: roundCents(item.price * item.qty),
    };
  });
}

/**
 * Processes a DICK'S Sporting Goods checkout order. `items` are already
 * priced from CATALOG by the route.
 */
async function processCheckout(orderData) {
  const startTime = Date.now();
  const orderId = `DSG${Date.now().toString().slice(-9)}`;
  const requestId = uuidv4();

  logger.info("Processing DICK'S checkout", {
    orderId,
    requestId,
    userId: orderData.userId,
    itemCount: orderData.items.length,
    state: orderData.state,
    shippingMethod: orderData.shippingMethod,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const subtotal = orderData.items.reduce((sum, item) => sum + item.price * item.qty, 0);
    const allItems = orderData.scorecardTier === 'gold'
      ? applyGiftWithPurchase(orderData.items, subtotal)
      : orderData.items;

    const totals = computeOrderTotal(subtotal, orderData.state, orderData.shippingMethod);
    const receipt = formatReceipt(allItems);
    const pointsEarned = computeScoreCardPoints(subtotal, orderData.scorecardTier);

    const duration = Date.now() - startTime;
    incrementMetric('checkout.success', { route: ROUTE, source: 'dsg-storefront' });
    recordTiming('checkout.latency', duration, { route: ROUTE });

    return {
      success: true,
      orderId,
      ...totals,
      receipt,
      scorecard: { tier: SCORECARD_TIERS[orderData.scorecardTier].label, pointsEarned },
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', { route: ROUTE, errorClass: error.name, source: 'dsg-storefront' });
    recordTiming('checkout.latency', duration, { route: ROUTE, error: 'true' });

    logger.error("DICK'S checkout failed", {
      orderId,
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, source: 'dsg-storefront', alert_path: 'instant',
      },
      extra: {
        orderId, userId: orderData.userId, state: orderData.state, scorecardTier: orderData.scorecardTier,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b66a0397.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'b66a0397',
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: "DICK'S Sporting Goods \u2014 Checkout",
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'scorecard_tier', value: String(orderData.scorecardTier) },
      ],
      extra: { orderId, userId: orderData.userId, itemCount: orderData.items.length },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@3.2.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error("Failed to trigger Devin session from DICK'S checkout error", { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  processCheckout,
  computeOrderTotal,
  computeScoreCardPoints,
  formatReceipt,
  applyGiftWithPurchase,
  findProduct,
  CATALOG,
  STATE_TAX,
  SHIPPING_METHODS,
  SCORECARD_TIERS,
  GIFT_WITH_PURCHASE,
};
