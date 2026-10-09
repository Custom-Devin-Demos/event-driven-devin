const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/dollar-general/checkout';
const SERVICE = 'customer-dollar-general-checkout';
const IMAGE_BASE = 'https://s7d1.scene7.com/is/image/dolgen/';

const CATALOG = {
  '00931504': { sku: '00931504', name: 'Tide Liquid Laundry Detergent, Original, 37 fl oz', price: 5.00, image: `${IMAGE_BASE}dg-00931504-1`, rating: 4.4, reviews: '2.8K', deal: { type: 'coupon', text: '$1.00 OFF' } },
  '00931004': { sku: '00931004', name: 'Gain Liquid Laundry Detergent, Original Scent, 46 fl oz, 32 loads', price: 5.00, image: `${IMAGE_BASE}dg-00931004-1`, rating: 4.8, reviews: '3.1K' },
  '01908001': { sku: '01908001', name: 'Coca-Cola Soda Soft Drink Bottles, 16.9 fl oz, 6 Pack', price: 6.25, image: `${IMAGE_BASE}dg-01908001-1`, rating: 4.7, reviews: '24.5K', deal: { type: 'offer', text: '2 Deals' } },
  '40014501': { sku: '40014501', name: 'Post Fruity Pebbles Breakfast Cereal, Family Size, 15 oz', price: 5.50, image: `${IMAGE_BASE}dg-40014501-1`, deal: { type: 'offer', text: '3 FOR $9 SELECT POST CEREAL' } },
  '00970903': { sku: '00970903', name: 'Febreze AIR Freshener, Original Scent with Gain, 8.8 oz', price: 3.50, image: `${IMAGE_BASE}dg-00970903-1`, rating: 4.5, reviews: '1.8K' },
  '00550804': { sku: '00550804', name: 'Dial Antibacterial Bar Soap, Mountain Fresh, 4 oz, 3 Bars', price: 3.95, image: `${IMAGE_BASE}dg-00550804-1`, rating: 4.2, reviews: '224', deal: { type: 'coupon', text: '$3.00 OFF' } },
  '00539001': { sku: '00539001', name: 'DG Health Electrolyte Solution, Mixed Fruit', price: 4.75, image: `${IMAGE_BASE}dg-00539001-1`, rating: 4.7, reviews: '219' },
  '00765202': { sku: '00765202', name: "REESE'S PIECES Peanut Butter Candy, Movie Theater Box, 4 oz", price: 1.25, image: `${IMAGE_BASE}dg-00765202-1`, rating: 4.7, reviews: '1.1K' },
};

const STORES = {
  13942: {
    storeNumber: '13942',
    address: '4718 Nolensville Pike, Nashville, TN 37211',
    deliveryZone: 'TN-NASH-07',
    sameDayDeliverySince: '2026-10-05',
  },
  '08715': {
    storeNumber: '08715',
    address: '1206 Gallatin Pike S, Madison, TN 37115',
    deliveryZone: 'TN-NASH-03',
    sameDayDeliverySince: '2025-03-18',
  },
};

/**
 * Same Day Delivery fee schedules, keyed by delivery zone. Every store with
 * Same Day Delivery is assigned to a zone, and checkout prices delivery from
 * that zone's schedule (base fee and the myDG free-fee perk).
 */
const DELIVERY_FEE_SCHEDULES = {
  'TN-NASH-01': { baseFee: 6.95, myDgFreeDeliveryEligible: true },
  'TN-NASH-03': { baseFee: 6.95, myDgFreeDeliveryEligible: true },
  'TN-NASH-07': { baseFee: 6.95, myDgFreeDeliveryEligible: true },
  'TN-MEM-02': { baseFee: 7.95, myDgFreeDeliveryEligible: true },
};

const TAX_RATE = 0.0925;

const MYDG_MEMBER = {
  memberId: 'MYDG-4471-2290',
  firstName: 'Jordan',
  freeDeliveriesRemaining: 1,
  deliveryAddress: '2231 Elm Hill Pike, Nashville, TN 37210',
};

const DG_SLACK_MEMBER_ID = process.env.DG_SLACK_MEMBER_ID || 'U0BU46F4WCU';
const DG_DEVIN_USER_ID = process.env.DEVIN_USER_ID_59C53533 || 'user-5e154bb05983499ba384fbeadd3f4478';

const SENTRY_ISSUE_QUERY = 'is:unresolved baseFee';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the Dollar General Same Day Delivery checkout failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/banking/transfer, POST /api/cba/payment and POST /api/storefront/checkout throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST ${ROUTE}, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the Dollar General storefront at app/public/verticals/59c53533.html (served at /dollar-general and /59c53533), whose cart "Place Order" button posts to POST ${ROUTE} in app/routes/verticals/59c53533.js. The checkout pipeline lives in app/services/verticals/59c53533.js: placeOrder -> priceOrder -> quoteDelivery -> applyMyDgFreeDelivery. Start at quoteDelivery: it looks up DELIVERY_FEE_SCHEDULES by the store's delivery zone, and store #13942 joined Same Day Delivery in the wave 7 rollout (zone TN-NASH-07) without a fee schedule, so the lookup returns undefined and applyMyDgFreeDelivery dereferences it while applying the myDG free-delivery perk. Add the missing zone's fee schedule (TN-NASH-07 is a Nashville zone, so use the same values as the other Nashville zones), and make a store whose zone has no fee schedule fail as a handled "Same Day Delivery isn't available for this store yet" checkout error (HTTP 409, no alert) instead of a TypeError. Do not change the page's look and feel, and do not touch the other verticals' intentional bugs. Verify by starting the server (node app/server.js) and POSTing the pre-filled cart for store 13942 with fulfillment "delivery" to ${ROUTE}, which must return a placed order with a $0.00 delivery fee after the myDG free delivery, and confirm npm run lint passes.

Reproduce before you diagnose. Your first action after reading the alert, before reading any source file and before proposing a cause, is to start the server (node app/server.js), open /dollar-general?repro=1 in a real browser and click "Place Order" on the pre-filled Same Day Delivery cart with your screen recording, so the recording shows the cart, the click and the checkout error. Always use ?repro=1 for your own submissions: the order fails identically but raises no Sentry event, Slack alert or Devin session, so your reproduction does not alert anyone or spawn another session. Only once you have reproduced the failure yourself do you start investigating. If it does not reproduce, stop and report that instead of fixing anything.

Verification evidence is mandatory and must be visual, not curl-only: after the fix, repeat exactly the same /dollar-general?repro=1 browser checkout with a second screen recording, showing the order confirmation where the error used to be. Attach both — an animated webp of the reproduction recording under a "Reproduction" heading and an animated webp of the post-fix recording plus a screenshot of the order confirmation under a "Fix Verification" heading — to the pull request, and post the same evidence as a comment on the PR. Do not report the fix as complete, and do not leave the PR description saying verification is pending, until both recordings are attached.`;

function validationError(message, code = 'INVALID_ORDER') {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function deliveryUnavailableError(store) {
  const error = new Error("Same Day Delivery isn't available for this store yet");
  error.name = 'DeliveryUnavailableError';
  error.code = 'DELIVERY_UNAVAILABLE';
  error.statusCode = 409;
  error.storeNumber = store.storeNumber;
  error.deliveryZone = store.deliveryZone;
  return error;
}

function roundCents(value) {
  return Math.round(value * 100) / 100;
}

function buildLines(items) {
  return items.map((item) => {
    const product = item && Object.hasOwn(CATALOG, String(item.sku)) ? CATALOG[item.sku] : undefined;
    if (!product) throw validationError(`Item ${item && item.sku ? item.sku : '(none)'} is not available at this store`);
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 24) {
      throw validationError(`Quantity for ${product.name} must be between 1 and 24`);
    }
    return { sku: product.sku, name: product.name, price: product.price, qty, lineTotal: roundCents(product.price * qty) };
  });
}

function applyMyDgFreeDelivery(schedule, member) {
  const baseFee = schedule.baseFee;
  const usesFreeDelivery = Boolean(member && member.freeDeliveriesRemaining > 0 && schedule.myDgFreeDeliveryEligible);
  return {
    baseFee,
    myDgDiscount: usesFreeDelivery ? baseFee : 0,
    deliveryFee: usesFreeDelivery ? 0 : baseFee,
    usedFreeDelivery: usesFreeDelivery,
  };
}

function quoteDelivery(store, member) {
  const schedule = Object.hasOwn(DELIVERY_FEE_SCHEDULES, store.deliveryZone)
    ? DELIVERY_FEE_SCHEDULES[store.deliveryZone]
    : undefined;
  if (!schedule) throw deliveryUnavailableError(store);
  return applyMyDgFreeDelivery(schedule, member);
}

function priceOrder(lines, fulfillment, store, member) {
  const subtotal = roundCents(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  const delivery = fulfillment === 'delivery'
    ? quoteDelivery(store, member)
    : { baseFee: 0, myDgDiscount: 0, deliveryFee: 0, usedFreeDelivery: false };
  const tax = roundCents(subtotal * TAX_RATE);
  return {
    subtotal,
    ...delivery,
    tax,
    total: roundCents(subtotal + delivery.deliveryFee + tax),
  };
}

function estimateReady(fulfillment) {
  const ready = new Date(Date.now() + (fulfillment === 'delivery' ? 2 : 1) * 60 * 60 * 1000);
  return ready.toISOString();
}

async function placeOrder(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const orderNumber = `DG${Math.floor(Math.random() * 1000000000).toString().padStart(9, '0')}`;
  const items = Array.isArray(data.items) ? data.items : [];
  const fulfillment = data.fulfillment;
  const store = Object.hasOwn(STORES, String(data.storeId)) ? STORES[data.storeId] : undefined;

  if (items.length === 0) throw validationError('Your cart is empty', 'EMPTY_CART');
  if (!['pickup', 'delivery'].includes(fulfillment)) throw validationError('Choose Store Pickup or Delivery');
  if (!store) throw validationError(`Unknown store: ${data.storeId || '(none)'}`);
  const lines = buildLines(items);

  logger.info('Placing Dollar General order', {
    requestId,
    orderNumber,
    storeNumber: store.storeNumber,
    deliveryZone: store.deliveryZone,
    fulfillment,
    itemCount: lines.length,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const totals = priceOrder(lines, fulfillment, store, MYDG_MEMBER);
    const duration = Date.now() - startTime;

    incrementMetric('dollar_general_checkout.success', { route: ROUTE, fulfillment, storeNumber: store.storeNumber });
    recordTiming('dollar_general_checkout.latency', duration, { route: ROUTE });

    return {
      success: true,
      orderNumber,
      fulfillment,
      store: { storeNumber: store.storeNumber, address: store.address },
      deliveryAddress: fulfillment === 'delivery' ? MYDG_MEMBER.deliveryAddress : null,
      lines,
      ...totals,
      readyBy: estimateReady(fulfillment),
      requestId,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    if (error.name === 'DeliveryUnavailableError') {
      incrementMetric('dollar_general_checkout.delivery_unavailable', {
        route: ROUTE,
        storeNumber: store.storeNumber,
        deliveryZone: store.deliveryZone,
      });
      recordTiming('dollar_general_checkout.latency', duration, { route: ROUTE, outcome: 'delivery_unavailable' });
      logger.warn('Same Day Delivery unavailable for store — no fee schedule for its zone', {
        requestId,
        orderNumber,
        storeNumber: store.storeNumber,
        deliveryZone: store.deliveryZone,
        service: SERVICE,
        route: ROUTE,
      });
      error.requestId = requestId;
      throw error;
    }

    incrementMetric('dollar_general_checkout.failure', {
      route: ROUTE,
      errorClass: error.name,
      fulfillment,
      storeNumber: store.storeNumber,
    });
    recordTiming('dollar_general_checkout.latency', duration, { route: ROUTE, error: 'true' });

    const context = {
      requestId,
      orderNumber,
      storeNumber: store.storeNumber,
      deliveryZone: store.deliveryZone,
      sameDayDeliverySince: store.sameDayDeliverySince,
      fulfillment,
      memberId: MYDG_MEMBER.memberId,
      skus: lines.map((line) => `${line.sku}x${line.qty}`).join(','),
    };

    logger.error('Dollar General checkout failed', {
      ...context,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    if (data.synthetic) {
      logger.info('Reproduction run — checkout failed without raising Sentry, Slack or a Devin session', {
        requestId,
        orderNumber,
        route: ROUTE,
      });
      error.requestId = requestId;
      throw error;
    }

    const tags = {
      route: ROUTE,
      service: SERVICE,
      fulfillment,
      storeNumber: store.storeNumber,
      deliveryZone: store.deliveryZone,
    };

    Sentry.captureException(error, { tags, extra: context });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/59c53533.js — applyMyDgFreeDelivery',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: SERVICE,
      verticalLabel: 'Dollar General — Same Day Delivery checkout',
      customer: '59c53533',
      slackMemberId: data.devinEmail ? '' : DG_SLACK_MEMBER_ID,
      slackMemberIdFallback: DG_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId || DG_DEVIN_USER_ID,
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
      logger.error('Failed to create Devin session for Dollar General checkout error', {
        requestId,
        orderNumber,
        error: alertError.message,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  placeOrder,
  priceOrder,
  quoteDelivery,
  applyMyDgFreeDelivery,
  deliveryUnavailableError,
  CATALOG,
  STORES,
  DELIVERY_FEE_SCHEDULES,
  MYDG_MEMBER,
  TAX_RATE,
  REMEDIATION_DIRECTIVE,
};
