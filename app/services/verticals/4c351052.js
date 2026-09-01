const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Slack member ID tagged as the human on-call on Publix order alerts.
 * Rendered in both the primary alert channel and the triage mirror.
 */
const PUBLIX_SLACK_MEMBER_ID = process.env.PUBLIX_SLACK_MEMBER_ID || 'U0BQZBHCNMA';

/**
 * Deli catalog items available in the online-ordering checkout flow.
 * Made-to-order items are prepared by the in-store deli and must be
 * scheduled against a prep window before the order is accepted.
 */
const CATALOG = {
  'DELI-CTS-W': {
    sku: 'DELI-CTS-W',
    name: 'Publix Chicken Tender Whole Sub',
    department: 'deli',
    madeToOrder: true,
    price: 11.99,
  },
  'DELI-ITAL-H': {
    sku: 'DELI-ITAL-H',
    name: 'Publix Italian Half Sub',
    department: 'deli',
    madeToOrder: true,
    price: 8.59,
  },
  'BAK-CCC-12': {
    sku: 'BAK-CCC-12',
    name: 'Chocolate Chip Cookies, 12-Count',
    department: 'bakery',
    madeToOrder: false,
    price: 4.99,
  },
};

/**
 * Store directory for pickup-order routing.
 */
const STORES = {
  1248: {
    storeNumber: 1248,
    name: 'Publix on Bayshore',
    address: '243 Bayshore Blvd Tampa, FL 33606-2328',
    taxRate: 0.075,
    deliOpens: '07:00',
  },
};

/**
 * Prep-window schedule for made-to-order deli items. Each window carries the
 * lead time the deli needs before the promised pickup slot and the maximum
 * number of made-to-order items it can absorb per slot.
 *
 * Windows are resolved from the pickup slot's hour by resolvePrepWindow().
 */
const DELI_PREP_WINDOWS = {
  morning: { label: 'Morning (9am\u201311am)', leadTimeMinutes: 25, maxItemsPerSlot: 12 },
  midday: { label: 'Midday (11am\u20132pm)', leadTimeMinutes: 35, maxItemsPerSlot: 18 },
  afternoon: { label: 'Afternoon (2pm\u20135pm)', leadTimeMinutes: 30, maxItemsPerSlot: 15 },
  evening: { label: 'Evening (5pm\u20138pm)', leadTimeMinutes: 40, maxItemsPerSlot: 10 },
};

/**
 * Payment methods accepted at pickup checkout.
 */
const PAYMENT_METHODS = {
  'pay-in-store': { label: 'Pay in-store', capturedAt: 'pickup' },
  'pay-now': { label: 'Pay now', capturedAt: 'order' },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Publix online pickup-order checkout vertical:',
  '- Service: `app/services/verticals/4c351052.js`',
  '- Route: `app/routes/verticals/4c351052.js`',
  '- Page: `app/public/verticals/4c351052.html` (served at `/publix`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Map a pickup slot (e.g. "8:30 am") to the deli prep window that owns it.
 *
 * The store's earliest online pickup slots open at 8:00 am, ahead of the
 * 9:00 am morning window, so slots before 9:00 am resolve to the
 * "early-morning" window.
 */
function resolvePrepWindow(pickupTime) {
  const match = /^(\d{1,2}):(\d{2})\s*(am|pm)$/i.exec(String(pickupTime).trim());
  if (!match) return null;

  let hour = parseInt(match[1], 10) % 12;
  if (match[3].toLowerCase() === 'pm') hour += 12;

  if (hour < 9) return 'early-morning';
  if (hour < 11) return 'morning';
  if (hour < 14) return 'midday';
  if (hour < 17) return 'afternoon';
  return 'evening';
}

/**
 * Build the prep schedule for the made-to-order items on the order. The deli
 * needs the window's lead time before the promised slot to start each item.
 */
function schedulePrep(items, pickupTime) {
  const madeToOrder = items.filter((item) => item.madeToOrder);
  if (madeToOrder.length === 0) return null;

  const windowKey = resolvePrepWindow(pickupTime);
  const window = DELI_PREP_WINDOWS[windowKey];

  return {
    window: windowKey,
    windowLabel: window.label,
    startPrepMinutesBeforeSlot: window.leadTimeMinutes,
    itemCount: madeToOrder.reduce((sum, item) => sum + item.quantity, 0),
    slotCapacity: window.maxItemsPerSlot,
  };
}

/**
 * Price the order against the store's tax rate.
 */
function priceOrder(items, store) {
  const subtotal = items.reduce((sum, item) => sum + item.price * item.quantity, 0);
  const tax = Math.round(subtotal * store.taxRate * 100) / 100;
  return {
    subtotal: Math.round(subtotal * 100) / 100,
    tax,
    total: Math.round((subtotal + tax) * 100) / 100,
  };
}

/**
 * Assemble the confirmation package returned to the customer.
 */
function buildConfirmation(orderId, store, items, pricing, prepSchedule, data) {
  return {
    orderId,
    status: 'placed',
    store: { storeNumber: store.storeNumber, name: store.name, address: store.address },
    items: items.map((item) => ({ sku: item.sku, name: item.name, quantity: item.quantity })),
    pricing,
    pickup: {
      date: data.pickupDate,
      time: data.pickupTime,
      prepSchedule,
    },
    payment: PAYMENT_METHODS[data.paymentMethod] || PAYMENT_METHODS['pay-in-store'],
    customer: { firstName: data.firstName, lastName: data.lastName },
  };
}

/**
 * Place an online pickup order.
 */
async function placeOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Placing online pickup order', {
    orderId,
    storeNumber: data.storeNumber,
    itemCount: (data.items || []).length,
    pickupDate: data.pickupDate,
    pickupTime: data.pickupTime,
    paymentMethod: data.paymentMethod,
    service: 'customer-4c351052-pickup-checkout',
    route: '/api/4c351052/place-order',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const store = STORES[data.storeNumber] || STORES[1248];
    const items = (data.items || []).map((line) => {
      const product = CATALOG[line.sku] || CATALOG['DELI-CTS-W'];
      return { ...product, quantity: line.quantity || 1 };
    });

    const pricing = priceOrder(items, store);
    const prepSchedule = schedulePrep(items, data.pickupTime);
    const confirmation = buildConfirmation(orderId, store, items, pricing, prepSchedule, data);

    confirmation.placedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('pickup_order.success', {
      route: '/api/4c351052/place-order',
      store: String(store.storeNumber),
    });
    recordTiming('pickup_order.latency', duration, {
      route: '/api/4c351052/place-order',
    });

    return confirmation;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('pickup_order.failure', {
      route: '/api/4c351052/place-order',
      errorClass: error.name,
    });
    recordTiming('pickup_order.latency', duration, {
      route: '/api/4c351052/place-order',
      error: 'true',
    });

    logger.error('Online pickup order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      pickupDate: data.pickupDate,
      pickupTime: data.pickupTime,
      paymentMethod: data.paymentMethod,
      service: 'customer-4c351052-pickup-checkout',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/4c351052/place-order',
        service: 'customer-4c351052-pickup-checkout',
        store: String(data.storeNumber || 1248),
      },
      extra: {
        orderId,
        pickupDate: data.pickupDate,
        pickupTime: data.pickupTime,
        paymentMethod: data.paymentMethod,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4c351052.js \u2014 schedulePrep',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : PUBLIX_SLACK_MEMBER_ID,
      slackMemberIdFallback: PUBLIX_SLACK_MEMBER_ID,
      service: 'customer-4c351052-pickup-checkout',
      verticalLabel: 'Pickup Checkout',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '4c351052',
      tags: [
        { key: 'route', value: '/api/4c351052/place-order' },
        { key: 'service', value: 'customer-4c351052-pickup-checkout' },
        { key: 'store', value: String(data.storeNumber || 1248) },
        { key: 'pickupSlot', value: data.pickupTime },
      ],
      extra: {
        orderId,
        pickupDate: data.pickupDate,
        pickupTime: data.pickupTime,
        paymentMethod: data.paymentMethod,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-4c351052-pickup-checkout@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for pickup order error', {
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
  STORES,
  DELI_PREP_WINDOWS,
  PAYMENT_METHODS,
};
