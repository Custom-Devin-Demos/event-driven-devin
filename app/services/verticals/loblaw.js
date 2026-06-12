const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Loblaws online grocery catalog — PC Express pickup & delivery SKUs (prices in CAD)
 */
const CATALOG = [
  { id: 'GRO-KETCH-750', name: 'Heinz Tomato Ketchup 750ml', price: 5.00, category: 'pantry', unit: '750 ml' },
  { id: 'GRO-CHEER-HN', name: 'Cheerios Honey Nut Cereal', price: 2.00, category: 'breakfast', unit: '430 g' },
  { id: 'GRO-POTATO-10', name: 'Russet Potatoes, 10 lb Bag', price: 3.50, category: 'produce', unit: '10 lb' },
  { id: 'GRO-MAND-2', name: 'Mandarin Oranges, 2 lb Bag', price: 5.00, category: 'produce', unit: '2 lb' },
  { id: 'GRO-PIZZA-PEP', name: 'Giuseppe Pizzeria Pepperoni Pizza', price: 5.00, category: 'frozen', unit: '730 g' },
  { id: 'GRO-BAGEL-EV', name: "D'Italiano Everything Bagels", price: 3.50, category: 'bakery', unit: '540 g' },
  { id: 'GRO-CAESAR-475', name: 'The Keg Caesar Dressing 475ml', price: 6.49, category: 'pantry', unit: '475 ml' },
  { id: 'GRO-CHICK-BITES', name: 'Chicken Breast Bites', price: 12.00, category: 'deli', unit: '1 ea' },
];

/**
 * PC Express fulfillment options — service fee + billing currency
 */
const FULFILLMENT_TIERS = {
  PICKUP: { fee: 0.00, currency: 'CAD' },
  DELIVERY: { fee: 9.95, currency: 'CAD' },
  RAPID: { fee: 12.95, currency: 'CAD' },
  EXPRESS_PASS: { fee: 0.00, currency: 'CAD' },
};

/**
 * Active PC Optimum offers redeemed at checkout — "20,000 points" reward.
 * Applied server-side so it appears on the order confirmation.
 */
const ACTIVE_OFFERS = [
  { sku: 'PCO-REWARD-20000', name: '20,000 PC Optimum Points Reward', price: 0, qty: 1 },
];

/**
 * Looks up the PC Optimum spend-and-save tier for a given order subtotal.
 */
function getApplicableSavings(subtotal) {
  if (subtotal >= 100) return { rate: 0.10, label: '$10 off every $100 with PC Optimum' };
  if (subtotal >= 50) return { rate: 0.05, label: '5% PC Optimum bonus on orders $50+' };
  return { rate: 0, label: 'None' };
}

/**
 * Merges active PC Optimum offers into the order line items.
 */
function applyOffers(items) {
  return [...items, ...ACTIVE_OFFERS];
}

/**
 * Computes the final order total for the grocery basket.
 */
function computeOrderTotal(subtotal, fulfillment) {
  const tierConfig = FULFILLMENT_TIERS[fulfillment];
  if (!tierConfig) {
    throw Object.assign(new Error(`Unknown fulfillment option: ${fulfillment}`), { code: 'INVALID_FULFILLMENT' });
  }
  const savings = getApplicableSavings(subtotal);
  const savingsAmount = subtotal * savings.rate;
  return {
    subtotal,
    fee: tierConfig.fee,
    savings: Math.round(savingsAmount * 100) / 100,
    savingsLabel: savings.label,
    total: Math.round((subtotal + tierConfig.fee - savingsAmount) * 100) / 100,
    currency: tierConfig.currency,
  };
}

/**
 * Formats a receipt for the order confirmation.
 * BUG: PCO-REWARD-20000 is not in CATALOG, so product.name crashes.
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
 * Processes a Loblaws PC Express grocery order.
 */
async function processGroceryOrder(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Loblaws grocery order', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'loblaw-grocery',
    route: '/api/loblaw/checkout',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyOffers(orderData.items);

    const computedSubtotal = allItems.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    ) || orderData.subtotal;

    const finalSubtotal = typeof computedSubtotal === 'string'
      ? parseFloat(computedSubtotal)
      : computedSubtotal;

    const result = computeOrderTotal(finalSubtotal, orderData.fulfillment);
    const receipt = formatReceipt(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/loblaw/checkout',
      source: 'loblaw-portal',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/loblaw/checkout',
    });

    return {
      success: true,
      orderId,
      total: result.total,
      fee: result.fee,
      savings: result.savings,
      savingsLabel: result.savingsLabel,
      currency: result.currency,
      receipt,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/loblaw/checkout',
      errorClass: error.name,
      source: 'loblaw-portal',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/loblaw/checkout',
      error: 'true',
    });

    logger.error('Loblaws grocery order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'loblaw-grocery',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/loblaw/checkout',
        service: 'loblaw-grocery',
        source: 'loblaw-portal',
      },
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        fulfillment: orderData.fulfillment,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/loblaw.js \u2014 formatReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'loblaw-grocery',
      verticalLabel: 'Loblaws Order',
      tags: [
        { key: 'route', value: '/api/loblaw/checkout' },
        { key: 'service', value: 'loblaw-grocery' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'loblaw-grocery@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Loblaws order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processGroceryOrder, computeOrderTotal, formatReceipt, applyOffers, CATALOG, FULFILLMENT_TIERS };
