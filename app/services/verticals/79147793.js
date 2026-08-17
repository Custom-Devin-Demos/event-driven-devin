const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const MEMBERSHIP_TIERS = {
  none: { label: 'No membership', programCode: 'pay_as_you_go' },
  dashpass_monthly: { label: 'Monthly membership', programCode: 'dashpass_monthly' },
  dashpass_annual: { label: 'Annual membership', programCode: 'dashpass_annual' },
};

const FEE_PROGRAMS = {
  pay_as_you_go: { serviceFeeRate: 0.15, deliveryFee: 2.99, smallOrderFee: 0 },
  dashpass_monthly: { serviceFeeRate: 0.08, deliveryFee: 0, smallOrderFee: 0 },
  // The annual membership rollout has no registered fee program yet.
};

const CART = {
  restaurant: {
    name: 'The Green Fork',
    address: '214 W 14th Street',
    deliveryTime: '25–35 min',
    rating: 4.8,
  },
  items: [
    { id: 'gf-bowl', name: 'Harvest grain bowl', description: 'Farro, roasted vegetables, tahini dressing', price: 13.95, quantity: 1 },
    { id: 'gf-chicken', name: 'Crispy chicken sandwich', description: 'Pickles, slaw, herb aioli', price: 15.5, quantity: 1 },
    { id: 'gf-cookies', name: 'Sea salt chocolate chip cookies', description: 'Two warm cookies', price: 6.25, quantity: 1 },
  ],
};

function getCart() {
  return CART;
}

function calculateOrderTotals(data) {
  const tier = MEMBERSHIP_TIERS[data.membershipTier] || MEMBERSHIP_TIERS.none;
  const feeProgram = FEE_PROGRAMS[tier.programCode];
  const subtotal = data.items.reduce((sum, item) => sum + (item.price * item.quantity), 0);
  const serviceFee = subtotal * feeProgram.serviceFeeRate;
  const deliveryFee = feeProgram.deliveryFee;
  const smallOrderFee = feeProgram.smallOrderFee;
  const tax = subtotal * 0.08875;
  const tip = Number(data.tip || 0);
  const total = subtotal + serviceFee + deliveryFee + smallOrderFee + tax + tip;

  return {
    subtotal: Number(subtotal.toFixed(2)),
    serviceFee: Number(serviceFee.toFixed(2)),
    deliveryFee: Number(deliveryFee.toFixed(2)),
    smallOrderFee: Number(smallOrderFee.toFixed(2)),
    tax: Number(tax.toFixed(2)),
    tip: Number(tip.toFixed(2)),
    total: Number(total.toFixed(2)),
    membership: tier.label,
    programCode: tier.programCode,
  };
}

async function processOrder(data) {
  const startTime = Date.now();
  const orderId = `DD-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Processing order checkout', {
    orderId,
    membershipTier: data.membershipTier,
    service: '79147793-api',
  });

  try {
    const receipt = calculateOrderTotals(data);
    const duration = Date.now() - startTime;

    incrementMetric('order.checkout.success', {
      route: '/api/79147793/order',
      membershipTier: data.membershipTier,
    });
    recordTiming('order.checkout.latency', duration, {
      route: '/api/79147793/order',
    });

    return {
      success: true,
      orderId,
      ...receipt,
      restaurant: CART.restaurant.name,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('order.checkout.failure', {
      route: '/api/79147793/order',
      errorClass: error.name,
      membershipTier: data.membershipTier,
    });
    recordTiming('order.checkout.latency', duration, {
      route: '/api/79147793/order',
      error: 'true',
    });

    logger.error('Order checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      membershipTier: data.membershipTier,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/79147793/order',
        service: '79147793-api',
        membershipTier: data.membershipTier,
      },
      extra: { orderId, membershipTier: data.membershipTier },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/79147793.js — calculateOrderTotals',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: '79147793-api',
      verticalLabel: 'DoorDash — Order Checkout',
      customer: '79147793',
      tags: [
        { key: 'route', value: '/api/79147793/order' },
        { key: 'service', value: '79147793-api' },
        { key: 'membershipTier', value: data.membershipTier },
      ],
      extra: { orderId, membershipTier: data.membershipTier },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '79147793@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to trigger Devin session from order checkout error', { error: alertError.message });
    });

    throw error;
  }
}

module.exports = {
  CART,
  FEE_PROGRAMS,
  MEMBERSHIP_TIERS,
  calculateOrderTotals,
  getCart,
  processOrder,
};
