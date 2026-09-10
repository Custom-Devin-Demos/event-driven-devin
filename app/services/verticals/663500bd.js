const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Bag catalog served to the checkout page.
 */
const CATALOG = [
  {
    sku: '7846231',
    name: 'Belted Wool Blend Wrap Coat',
    brand: 'Open Edit',
    price: 149.0,
    color: 'Camel',
    size: 'M',
    category: 'coats',
  },
  {
    sku: '6613094',
    name: 'Mercer Pebbled Leather Zip Crossbody Bag',
    brand: 'Michael Kors',
    price: 228.0,
    color: 'Vanilla',
    size: 'One Size',
    category: 'handbags',
  },
  {
    sku: '5920188',
    name: 'Cloudsurfer 2 Running Shoe',
    brand: 'On',
    price: 159.99,
    color: 'Ivory/Sand',
    size: '9',
    category: 'shoes',
  },
];

/**
 * Nordy Club membership tiers. Each tier maps to the rewards program code that
 * prices its point accrual at checkout.
 */
const MEMBERSHIP_TIERS = {
  member: { label: 'Member', programCode: 'nordy_member' },
  influencer: { label: 'Influencer', programCode: 'nordy_influencer' },
  ambassador: { label: 'Ambassador', programCode: 'nordy_ambassador' },
  icon: { label: 'Icon', programCode: 'nordy_icon' },
};

/**
 * Rewards programs keyed by program code: point accrual and the benefits the
 * order confirmation reports back to the member.
 */
const REWARDS_PROGRAMS = {
  nordy_member: {
    label: 'The Nordy Club \u2014 Member',
    pointsPerDollar: 1,
    bonusPointEvents: 0,
    freeAlterations: false,
    freeShippingThreshold: 89,
  },
  nordy_influencer: {
    label: 'The Nordy Club \u2014 Influencer',
    pointsPerDollar: 1,
    bonusPointEvents: 2,
    freeAlterations: false,
    freeShippingThreshold: 0,
  },
  nordy_ambassador: {
    label: 'The Nordy Club \u2014 Ambassador',
    pointsPerDollar: 1,
    bonusPointEvents: 4,
    freeAlterations: true,
    freeShippingThreshold: 0,
  },
};

/**
 * Shipping speeds the checkout can price.
 */
const SHIPPING_METHODS = {
  standard: { label: 'Standard (3-5 business days)', charge: 8.95, taxable: false },
  express: { label: 'Express (2 business days)', charge: 17.95, taxable: false },
  pickup: { label: 'Free store pickup', charge: 0, taxable: false },
};

const TAX_RATE = 0.10025;

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Nordstrom bag checkout vertical:',
  '- Service: `app/services/verticals/663500bd.js`',
  '- Route: `app/routes/verticals/663500bd.js`',
  '- Page: `app/public/verticals/663500bd.html` (served at `/nordstrom`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findProduct(sku) {
  return CATALOG.find((product) => product.sku === sku) || null;
}

/**
 * Resolve the rewards program that prices a member's point accrual.
 */
function resolveRewardsProgram(tierId) {
  const tier = MEMBERSHIP_TIERS[tierId] || MEMBERSHIP_TIERS.member;
  return { tier, program: REWARDS_PROGRAMS[tier.programCode] };
}

/**
 * Points and member benefits earned by an order.
 */
function computeRewards(merchandise, tierId) {
  const { tier, program } = resolveRewardsProgram(tierId);

  return {
    tier: tier.label,
    programLabel: program.label,
    pointsEarned: Math.round(merchandise * program.pointsPerDollar),
    bonusPointEvents: program.bonusPointEvents,
    freeAlterations: program.freeAlterations,
    freeShippingThreshold: program.freeShippingThreshold,
  };
}

/**
 * Price shipping for the order. Members whose tier ships free pay nothing;
 * everyone else pays the selected speed unless the bag clears the threshold.
 */
function computeShipping(merchandise, shippingMethod, rewards) {
  const method = SHIPPING_METHODS[shippingMethod] || SHIPPING_METHODS.standard;
  const threshold = rewards.freeShippingThreshold;
  const waived = threshold === 0 || merchandise >= threshold;

  return {
    method: method.label,
    charge: waived ? 0 : Math.round(method.charge * 100) / 100,
  };
}

/**
 * Build the order summary shown on the confirmation screen.
 */
function buildOrderSummary(orderId, items, rewards, shipping) {
  const merchandise = items.reduce((sum, item) => sum + item.price * item.qty, 0);
  const tax = merchandise * TAX_RATE;

  return {
    success: true,
    orderId,
    status: 'confirmed',
    itemCount: items.reduce((sum, item) => sum + item.qty, 0),
    itemTotal: Math.round(merchandise * 100) / 100,
    shippingLabel: shipping.method,
    shipping: shipping.charge,
    estimatedTax: Math.round(tax * 100) / 100,
    total: Math.round((merchandise + shipping.charge + tax) * 100) / 100,
    rewards,
    placedAt: new Date().toISOString(),
  };
}

/**
 * Place a bag checkout order.
 */
async function placeOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  const bagItems = (data.items || []).map((item) => {
    const product = findProduct(item.sku);
    return {
      sku: item.sku,
      name: product ? product.name : item.name || 'Item',
      brand: product ? product.brand : item.brand || '',
      price: product ? product.price : Number(item.price) || 0,
      qty: Number(item.qty) || 1,
    };
  });

  logger.info('Placing bag checkout order', {
    orderId,
    lines: bagItems.length,
    membershipTier: data.membershipTier,
    shippingMethod: data.shippingMethod,
    storeNumber: data.storeNumber,
    service: 'customer-663500bd-checkout',
    route: '/api/663500bd/checkout',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    if (!bagItems.length) {
      const empty = new Error('Your Shopping Bag is empty.');
      empty.name = 'ValidationError';
      empty.code = 'EMPTY_BAG';
      empty.statusCode = 400;
      throw empty;
    }

    const merchandise = bagItems.reduce((sum, item) => sum + item.price * item.qty, 0);
    const rewards = computeRewards(merchandise, data.membershipTier);
    const shipping = computeShipping(merchandise, data.shippingMethod, rewards);
    const summary = buildOrderSummary(orderId, bagItems, rewards, shipping);

    const duration = Date.now() - startTime;

    incrementMetric('bag_checkout.success', {
      route: '/api/663500bd/checkout',
      tier: data.membershipTier || 'member',
    });
    recordTiming('bag_checkout.latency', duration, {
      route: '/api/663500bd/checkout',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('bag_checkout.failure', {
      route: '/api/663500bd/checkout',
      errorClass: error.name,
      tier: data.membershipTier || 'member',
    });
    recordTiming('bag_checkout.latency', duration, {
      route: '/api/663500bd/checkout',
      error: 'true',
    });

    logger.error('Bag checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      membershipTier: data.membershipTier,
      shippingMethod: data.shippingMethod,
      lines: bagItems.length,
      service: 'customer-663500bd-checkout',
    });

    if (error.statusCode === 400) {
      throw error;
    }

    Sentry.captureException(error, {
      tags: {
        route: '/api/663500bd/checkout',
        service: 'customer-663500bd-checkout',
        tier: data.membershipTier,
      },
      extra: {
        orderId,
        membershipTier: data.membershipTier,
        shippingMethod: data.shippingMethod,
        storeNumber: data.storeNumber,
        lines: bagItems.length,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/663500bd.js \u2014 computeRewards',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-663500bd-checkout',
      verticalLabel: 'Bag Checkout',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '663500bd',
      tags: [
        { key: 'route', value: '/api/663500bd/checkout' },
        { key: 'service', value: 'customer-663500bd-checkout' },
        { key: 'tier', value: data.membershipTier },
        { key: 'shipping', value: data.shippingMethod },
      ],
      extra: {
        orderId,
        membershipTier: data.membershipTier,
        shippingMethod: data.shippingMethod,
        storeNumber: data.storeNumber,
        lines: bagItems.length,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-663500bd-checkout@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for bag checkout error', {
        error: err.message,
        orderId,
      });
    });

    throw error;
  }
}

module.exports = {
  placeOrder,
  REMEDIATION_DIRECTIVE,
  CATALOG,
  MEMBERSHIP_TIERS,
  REWARDS_PROGRAMS,
  SHIPPING_METHODS,
  resolveRewardsProgram,
  computeRewards,
  computeShipping,
};
