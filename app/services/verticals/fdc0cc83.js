const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Walmart online grocery + general merchandise catalog.
 */
const CATALOG = [
  { id: 'WMT-GV-MILK', name: 'Great Value Whole Milk, 1 Gallon', price: 3.48, category: 'grocery', unit: '128 fl oz' },
  { id: 'WMT-BAN-ORG', name: 'Fresh Organic Bananas', price: 1.94, category: 'produce', unit: 'per bunch' },
  { id: 'WMT-EQ-DTG', name: 'Equate Detergent Pods, 81 ct', price: 12.97, category: 'household', unit: '81 ct' },
  { id: 'WMT-ONN-TAB', name: 'onn. 10.1" Tablet, 32GB', price: 99.00, category: 'electronics', unit: 'each' },
  { id: 'WMT-MS-TEE', name: "Time and Tru Women's Crewneck Tee", price: 8.98, category: 'apparel', unit: 'each' },
  { id: 'WMT-GV-COF', name: 'Great Value Colombian Ground Coffee, 30.5 oz', price: 9.62, category: 'grocery', unit: '30.5 oz' },
  { id: 'WMT-PMP-DIA', name: 'Parent\u2019s Choice Diapers, Size 4, 144 ct', price: 27.94, category: 'baby', unit: '144 ct' },
  { id: 'WMT-HB-TIRE', name: 'Goodyear Reliant All-Season Tire 225/65R17', price: 118.00, category: 'auto', unit: 'each' },
];

/**
 * Store fulfillment plans keyed by fulfillment method.
 * Each plan carries the base fee charged before Walmart+ benefits are applied.
 */
const FULFILLMENT_PLANS = {
  pickup: { baseFee: 0.00, slaMinutes: 240, label: 'Store Pickup' },
  delivery: { baseFee: 9.95, slaMinutes: 180, label: 'Scheduled Delivery' },
  shipping: { baseFee: 6.99, slaMinutes: 4320, label: 'Ship to Home' },
};

/**
 * Sales tax by ship-to state.
 */
const TAX_RATES = {
  AR: 0.0650,
  TX: 0.0825,
  CA: 0.0725,
  FL: 0.0600,
  NY: 0.0888,
};

/**
 * Walmart+ membership benefits.
 */
const MEMBERSHIP_TIERS = {
  none: { deliveryFeeWaiver: 0, fuelDiscount: 0 },
  plus: { deliveryFeeWaiver: 1, fuelDiscount: 0.10 },
};

/**
 * Fulfillment methods currently exposed in the storefront rollout.
 * `express` was enabled for the 2-hour delivery pilot.
 */
const ENABLED_FULFILLMENT_METHODS = ['pickup', 'delivery', 'shipping', 'express'];

/**
 * Maps a storefront fulfillment selection onto its internal plan key.
 */
const FULFILLMENT_PLAN_KEYS = {
  pickup: 'pickup',
  delivery: 'delivery',
  shipping: 'shipping',
  express: 'express_2hr',
};

/**
 * Resolves the fulfillment plan for a storefront selection.
 */
function resolveFulfillmentPlan(method) {
  if (!ENABLED_FULFILLMENT_METHODS.includes(method)) {
    throw Object.assign(new Error(`Fulfillment method not available: ${method}`), { code: 'FULFILLMENT_UNAVAILABLE' });
  }
  return FULFILLMENT_PLANS[FULFILLMENT_PLAN_KEYS[method]];
}

/**
 * Looks up the Walmart+ membership benefits for a customer.
 */
function getMembershipBenefits(membership) {
  return MEMBERSHIP_TIERS[membership] || MEMBERSHIP_TIERS.none;
}

/**
 * Computes the order total including tax and fulfillment fees.
 */
function computeOrderTotal(subtotal, state, method, membership) {
  const taxRate = TAX_RATES[state];
  if (taxRate === undefined) {
    throw Object.assign(new Error(`Unsupported ship-to state: ${state}`), { code: 'INVALID_STATE' });
  }

  const plan = resolveFulfillmentPlan(method);
  const benefits = getMembershipBenefits(membership);
  const fulfillmentFee = plan.baseFee * (1 - benefits.deliveryFeeWaiver);
  const tax = subtotal * taxRate;

  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    fulfillmentFee: Math.round(fulfillmentFee * 100) / 100,
    fulfillmentLabel: plan.label,
    etaMinutes: plan.slaMinutes,
    total: Math.round((subtotal + tax + fulfillmentFee) * 100) / 100,
  };
}

/**
 * Builds the itemized order summary shown on the confirmation page.
 */
function buildOrderSummary(items) {
  return items.map((item) => {
    const product = CATALOG.find((p) => p.id === item.sku) || {};
    return {
      sku: item.sku,
      name: product.name || item.sku,
      unit: product.unit || '',
      qty: item.qty,
      lineTotal: Math.round(item.price * item.qty * 100) / 100,
    };
  });
}

/**
 * Places a Walmart online order.
 */
async function placeOrder(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Placing Walmart order', {
    orderId,
    customerId: orderData.customerId,
    fulfillmentMethod: orderData.fulfillmentMethod,
    storeId: orderData.storeId,
    service: 'walmart-ecommerce',
    route: '/api/fdc0cc83/order',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const items = orderData.items || [];
    const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0) || orderData.subtotal;

    const totals = computeOrderTotal(
      subtotal,
      orderData.state,
      orderData.fulfillmentMethod,
      orderData.membership,
    );
    const summary = buildOrderSummary(items);

    const duration = Date.now() - startTime;

    incrementMetric('order.success', {
      route: '/api/fdc0cc83/order',
      source: 'walmart-storefront',
    });
    recordTiming('order.latency', duration, {
      route: '/api/fdc0cc83/order',
    });

    return {
      success: true,
      orderId,
      storeId: orderData.storeId,
      ...totals,
      items: summary,
      status: 'placed',
      placedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('order.failure', {
      route: '/api/fdc0cc83/order',
      errorClass: error.name,
      source: 'walmart-storefront',
    });
    recordTiming('order.latency', duration, {
      route: '/api/fdc0cc83/order',
      error: 'true',
    });

    logger.error('Walmart order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      customerId: orderData.customerId,
      fulfillmentMethod: orderData.fulfillmentMethod,
      service: 'walmart-ecommerce',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/fdc0cc83/order',
        service: 'walmart-ecommerce',
        source: 'walmart-storefront',
      },
      extra: {
        orderId,
        customerId: orderData.customerId,
        storeId: orderData.storeId,
        fulfillmentMethod: orderData.fulfillmentMethod,
        state: orderData.state,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/fdc0cc83.js \u2014 computeOrderTotal',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'fdc0cc83',
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'walmart-ecommerce',
      verticalLabel: 'Walmart Order Checkout',
      tags: [
        { key: 'route', value: '/api/fdc0cc83/order' },
        { key: 'service', value: 'walmart-ecommerce' },
        { key: 'fulfillment_method', value: String(orderData.fulfillmentMethod) },
      ],
      extra: {
        orderId,
        customerId: orderData.customerId,
        storeId: orderData.storeId,
        fulfillmentMethod: orderData.fulfillmentMethod,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'walmart-ecommerce@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Walmart order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  placeOrder,
  computeOrderTotal,
  resolveFulfillmentPlan,
  getMembershipBenefits,
  buildOrderSummary,
  CATALOG,
  FULFILLMENT_PLANS,
  TAX_RATES,
};
