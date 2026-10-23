const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/best-buy/checkout';
const SERVICE = 'customer-best-buy-checkout';
const VERTICAL_LABEL = 'Best Buy — Black Friday checkout';

/**
 * Black Friday doorbuster catalog. Prices mirror the public Samsung S85H listing
 * on bestbuy.com (comp. value $1,999.99) with an invented Black Friday price.
 */
const CATALOG = {
  6671348: {
    sku: '6671348',
    model: 'QN65S85HAEXZA',
    brand: 'Samsung',
    name: 'Samsung - 65" Class S85H OLED 4K UHD SmartVision AI Smart Tizen TV (2026)',
    shortName: 'Samsung 65" S85H OLED 4K TV',
    price: 1099.99,
    compValue: 1999.99,
    limitPerOrder: 3,
    image: '/verticals/assets/4dd0a997/tv-front.jpg',
  },
};

const DEFAULT_SKU = '6671348';

/**
 * My Best Buy paid memberships (corporate.bestbuy.com/2026/holiday-preview):
 * Plus and Total members earn 1% back in rewards on eligible purchases, or 6%
 * back when they pay with a My Best Buy credit card.
 */
const MEMBER_REWARD_RATES = {
  plus: { label: 'My Best Buy Plus', standard: 0.01, creditCard: 0.06 },
  total: { label: 'My Best Buy Total', standard: 0.01, creditCard: 0.06 },
};

/**
 * Customer profiles as they arrive from the My Best Buy account service. Paid
 * members who joined before the June 2023 rename still carry the membership
 * program code they were enrolled with.
 */
const CUSTOMERS = {
  'BBY-30418': {
    customerId: 'BBY-30418',
    firstName: 'Jordan',
    lastName: 'Reyes',
    email: 'jordan.reyes@example.com',
    membership: { program: 'totaltech', displayName: 'My Best Buy Total', memberSince: '2022-03-14' },
    payment: { type: 'my-best-buy-card', label: 'My Best Buy Visa', last4: '4417' },
    fulfillment: { type: 'pickup', store: 'Richfield, MN', zip: '55423' },
  },
  'BBY-58120': {
    customerId: 'BBY-58120',
    firstName: 'Alex',
    lastName: 'Chen',
    email: 'alex.chen@example.com',
    membership: { program: 'total', displayName: 'My Best Buy Total', memberSince: '2024-11-02' },
    payment: { type: 'my-best-buy-card', label: 'My Best Buy Visa', last4: '2291' },
    fulfillment: { type: 'pickup', store: 'Richfield, MN', zip: '55423' },
  },
  'BBY-77302': {
    customerId: 'BBY-77302',
    firstName: 'Sam',
    lastName: 'Patel',
    email: 'sam.patel@example.com',
    membership: { program: 'plus', displayName: 'My Best Buy Plus', memberSince: '2025-01-19' },
    payment: { type: 'card', label: 'Visa', last4: '0812' },
    fulfillment: { type: 'pickup', store: 'Richfield, MN', zip: '55423' },
  },
  guest: {
    customerId: 'guest',
    firstName: 'Guest',
    lastName: '',
    email: '',
    membership: null,
    payment: { type: 'card', label: 'Mastercard', last4: '5530' },
    fulfillment: { type: 'pickup', store: 'Richfield, MN', zip: '55423' },
  },
};

const DEFAULT_CUSTOMER_ID = 'BBY-30418';
const SALES_TAX_RATE = 0.07875;

const BBY_SLACK_MEMBER_ID = process.env.BESTBUY_SLACK_MEMBER_ID || 'U0BU46F4WCU';
const BBY_DEVIN_USER_ID = process.env.DEVIN_USER_ID_4DD0A997 || 'user-5e154bb05983499ba384fbeadd3f4478';

const SENTRY_ISSUE_QUERY = 'is:unresolved creditCard';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the Best Buy Black Friday checkout failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/banking/transfer, POST /api/cba/payment and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST ${ROUTE}, do not investigate or modify any other vertical (including the separate Best Buy supply-chain demo in app/services/verticals/6074332d.js), and do not widen the Sentry or Datadog search beyond this route. The failing surface is the Best Buy storefront at app/public/verticals/4dd0a997.html (served at /best-buy and /4dd0a997): the shopper adds the Samsung 65" S85H OLED TV to the cart and clicks "Checkout", which posts to POST ${ROUTE} in app/routes/verticals/4dd0a997.js. The pipeline lives in app/services/verticals/4dd0a997.js: checkout -> priceOrder -> applyMemberRewards -> memberRewardRate. Start at memberRewardRate: it looks up the customer's paid membership in MEMBER_REWARD_RATES, which only knows the current program codes "plus" and "total". Members who joined before Best Buy renamed Totaltech to My Best Buy Total in June 2023 (for example BBY-30418, Jordan Reyes) still carry the legacy program code "totaltech", so the lookup returns undefined and the rate read throws. Treat the legacy "totaltech" code as My Best Buy Total, and make any other unrecognised membership program check out without member rewards (logged as a warning, no alert) instead of throwing. Do not change the reward rates, prices or tax, do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing {"customerId":"BBY-30418","items":[{"sku":"6671348","quantity":1}]} to ${ROUTE}, which must return success with subtotal 1099.99, rewards.rate 0.06 and rewards.amount 66, and confirm npm run lint passes.

Reproduce before you diagnose. Your first action after reading the alert, before reading any source file and before proposing a cause, is to start the server (node app/server.js), open /best-buy?repro=1 in a real browser and, as the pre-selected shopper (Jordan Reyes), click "Add to cart", go to the cart and click "Checkout" with your screen recording, so the recording shows the product, the cart, the click and the error. Always use ?repro=1 for your own checkouts: the request fails identically but raises no Sentry event, Slack alert or Devin session, so your reproduction does not alert anyone or spawn another session. Only once you have reproduced the failure yourself do you start investigating. If it does not reproduce, stop and report that instead of fixing anything.

Verification evidence is mandatory and must be visual, not curl-only: after the fix, repeat exactly the same /best-buy?repro=1 browser flow with a second screen recording, showing the order confirmation (with the $66.00 in rewards) where the error used to be. Attach both — an animated webp of the reproduction recording under a "Reproduction" heading and an animated webp of the post-fix recording plus a screenshot of the confirmation under a "Fix Verification" heading — to the pull request, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until both recordings are attached.`;

function validationError(message, code = 'INVALID_REQUEST') {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

function normaliseItems(items) {
  if (!Array.isArray(items) || items.length === 0) throw validationError('Your cart is empty', 'EMPTY_CART');
  const quantities = new Map();
  items.forEach((item) => {
    const sku = String((item && item.sku) || '');
    if (!Object.hasOwn(CATALOG, sku)) throw validationError(`SKU ${sku || '(none)'} is no longer available`, 'UNKNOWN_SKU');
    const quantity = Number(item.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) throw validationError('Quantity must be at least 1', 'INVALID_QUANTITY');
    quantities.set(sku, (quantities.get(sku) || 0) + quantity);
  });
  return [...quantities].map(([sku, quantity]) => {
    const product = CATALOG[sku];
    if (quantity > product.limitPerOrder) {
      throw validationError(`Limit ${product.limitPerOrder} per customer on this Black Friday deal`, 'LIMIT_EXCEEDED');
    }
    return {
      sku,
      name: product.name,
      quantity,
      price: product.price,
      lineTotal: roundCents(product.price * quantity),
    };
  });
}

function memberRewardRate(customer) {
  const membership = customer.membership;
  if (!membership) return 0;
  const tier = MEMBER_REWARD_RATES[membership.program];
  return customer.payment.type === 'my-best-buy-card' ? tier.creditCard : tier.standard;
}

function applyMemberRewards(customer, subtotal) {
  const rate = memberRewardRate(customer);
  return {
    program: customer.membership ? customer.membership.displayName : null,
    rate,
    amount: roundCents(subtotal * rate),
  };
}

function priceOrder(customer, lines) {
  const subtotal = roundCents(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  const savings = roundCents(lines.reduce((sum, line) => sum + (CATALOG[line.sku].compValue - line.price) * line.quantity, 0));
  const rewards = applyMemberRewards(customer, subtotal);
  const tax = roundCents(subtotal * SALES_TAX_RATE);
  return {
    subtotal,
    savings,
    shipping: 0,
    tax,
    total: roundCents(subtotal + tax),
    rewards,
  };
}

function publicCustomer(customer) {
  return {
    customerId: customer.customerId,
    firstName: customer.firstName,
    lastName: customer.lastName,
    membership: customer.membership
      ? { displayName: customer.membership.displayName, memberSince: customer.membership.memberSince }
      : null,
    payment: customer.payment,
    fulfillment: customer.fulfillment,
  };
}

function orderNumber() {
  return `BBY01-8064${Math.floor(Math.random() * 100000000).toString().padStart(8, '0')}`;
}

async function checkout(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const customerId = String(data.customerId || '');
  const customer = Object.hasOwn(CUSTOMERS, customerId) ? CUSTOMERS[customerId] : undefined;

  if (!customer) throw validationError(`We couldn't find your account (${customerId || 'none'})`, 'UNKNOWN_CUSTOMER');

  const lines = normaliseItems(data.items);
  const units = lines.reduce((sum, line) => sum + line.quantity, 0);

  logger.info('Best Buy checkout started', {
    requestId,
    customerId,
    membershipProgram: customer.membership ? customer.membership.program : 'none',
    units,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const pricing = priceOrder(customer, lines);
    const duration = Date.now() - startTime;

    incrementMetric('bestbuy_checkout.success', { route: ROUTE, membership: customer.membership ? customer.membership.program : 'none' });
    recordTiming('bestbuy_checkout.latency', duration, { route: ROUTE });

    return {
      success: true,
      orderNumber: orderNumber(),
      customer: { customerId, firstName: customer.firstName, lastName: customer.lastName },
      items: lines,
      payment: customer.payment,
      fulfillment: customer.fulfillment,
      ...pricing,
      requestId,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const membershipProgram = customer.membership ? customer.membership.program : 'none';

    incrementMetric('bestbuy_checkout.failure', { route: ROUTE, errorClass: error.name, membership: membershipProgram });
    recordTiming('bestbuy_checkout.latency', duration, { route: ROUTE, error: 'true' });

    const context = {
      requestId,
      customerId,
      membershipProgram,
      memberSince: customer.membership ? customer.membership.memberSince : null,
      paymentType: customer.payment.type,
      skus: lines.map((line) => line.sku),
      units,
      cartSubtotal: roundCents(lines.reduce((sum, line) => sum + line.lineTotal, 0)),
    };

    logger.error('Best Buy checkout failed', {
      ...context,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    if (data.synthetic) {
      logger.info('Reproduction run — checkout failed without raising Sentry, Slack or a Devin session', {
        requestId,
        route: ROUTE,
      });
      error.requestId = requestId;
      throw error;
    }

    const tags = {
      route: ROUTE,
      service: SERVICE,
      membershipProgram,
      paymentType: customer.payment.type,
    };

    Sentry.captureException(error, { tags, extra: context });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/4dd0a997.js — memberRewardRate',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: SERVICE,
      verticalLabel: VERTICAL_LABEL,
      customer: '4dd0a997',
      slackMemberId: data.devinEmail ? '' : BBY_SLACK_MEMBER_ID,
      slackMemberIdFallback: BBY_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId || BBY_DEVIN_USER_ID,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      extra: context,
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Best Buy checkout error', {
        requestId,
        error: alertError.message,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  checkout,
  priceOrder,
  applyMemberRewards,
  memberRewardRate,
  publicCustomer,
  CATALOG,
  CUSTOMERS,
  MEMBER_REWARD_RATES,
  DEFAULT_CUSTOMER_ID,
  DEFAULT_SKU,
  REMEDIATION_DIRECTIVE,
};
