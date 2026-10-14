/**
 * Customer 20c2fe38 — streaming subscription checkout.
 *
 * Starts checkout for the plan behind the homepage "Stream Now" CTA: reads the
 * subscribe selection (`plan,quantity,interval`, the same token the subscribe
 * links carry), resolves the billable offer, works out the free-trial window
 * and first renewal, and returns the checkout summary the page hands off to
 * payment.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const catalog = require('./20c2fe38-catalog');

const CUSTOMER = '20c2fe38';
const SERVICE = 'customer-20c2fe38-subscribe';
const ROUTE = '/api/20c2fe38/subscribe';
const RELEASE = 'dtc-subscribe@5.12.0';
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS_20C2FE38) || 60 * 1000;

const DEFAULT_SELECTION = 'foxone,1,month';
const MAX_SELECTION_LENGTH = 64;
const MAX_STREAMS = 6;
const SELECTION_PATTERN = /^[a-z_]+,\d{1,2},[a-z]+$/;
const DAY_MS = 24 * 60 * 60 * 1000;

let lastAlertAt = 0;

function money(value) {
  return Math.round(value * 100) / 100;
}

function badRequest(message, code, statusCode = 400) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function parseSelection(select) {
  const [planCode, quantity, interval] = select.split(',');
  return { planCode, quantity: Number(quantity), interval };
}

function validateSelection(select) {
  if (typeof select !== 'string' || select.length > MAX_SELECTION_LENGTH || !SELECTION_PATTERN.test(select)) {
    throw badRequest('select must look like plan,quantity,interval', 'INVALID_SELECTION');
  }
  const selection = parseSelection(select);
  if (!catalog.hasPlan(selection.planCode)) {
    throw badRequest(`Unknown plan: ${selection.planCode}`, 'PLAN_NOT_FOUND', 404);
  }
  if (selection.quantity < 1 || selection.quantity > MAX_STREAMS) {
    throw badRequest(`quantity must be between 1 and ${MAX_STREAMS}`, 'INVALID_QUANTITY');
  }
  return selection;
}

function addMonths(date, months) {
  const next = new Date(date.getTime());
  next.setUTCMonth(next.getUTCMonth() + months);
  return next;
}

function trialWindow(offer, startsAt) {
  const days = offer.trial ? offer.trial.days : 0;
  const endsAt = new Date(startsAt.getTime() + days * DAY_MS);
  return { days, endsAt };
}

function renewalDate(firstChargeAt, interval) {
  return addMonths(firstChargeAt, catalog.periodMonths(interval));
}

function buildCheckout(selection, now = new Date()) {
  const plan = catalog.getPlan(selection.planCode);
  const offer = catalog.findOffer(selection.planCode, selection.interval);
  const trial = trialWindow(offer, now);
  const renewsAt = renewalDate(trial.endsAt, selection.interval);
  const dueToday = trial.days > 0 ? 0 : money(offer.amount * selection.quantity);

  return {
    plan: { code: plan.code, name: plan.name, entitlements: plan.entitlements },
    priceId: offer.priceId,
    quantity: selection.quantity,
    billing: {
      amount: offer.amount,
      currency: offer.currency,
      period: offer.period,
      firstChargeAt: trial.endsAt.toISOString(),
      renewsAt: renewsAt.toISOString(),
    },
    trialDays: trial.days,
    dueToday,
    checkoutUrl: `https://subs.fox.com/subscribe/payment?planId=${offer.priceId}`,
  };
}

function listPlans() {
  return { plans: catalog.listPlans() };
}

function sentryIssueUrl() {
  const org = process.env.SENTRY_ORG_SLUG || 'sentry-org';
  const project = process.env.SENTRY_PROJECT_ID || '';
  return `https://${org}.sentry.io/issues/?project=${project}&query=is%3Aunresolved`;
}

function raiseAlert(error, requestId, data) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
    logger.warn('Subscribe alert suppressed by cooldown', { requestId, cooldownMs: ALERT_COOLDOWN_MS });
    return;
  }
  lastAlertAt = now;

  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: sentryIssueUrl(),
    culprit: 'app/services/verticals/20c2fe38.js in buildCheckout',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinOrgId: data.devinOrgId,
    devinEmail: data.devinEmail,
    service: SERVICE,
    verticalLabel: 'Streaming Subscription Checkout',
    customer: CUSTOMER,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'plan', value: data.planCode },
    ],
    extra: { requestId, select: data.select },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: RELEASE,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).then((result) => {
    if (!result && lastAlertAt === now) lastAlertAt = 0;
  }).catch((alertError) => {
    if (lastAlertAt === now) lastAlertAt = 0;
    logger.error('Failed to raise alert for subscribe failure', { error: alertError.message, requestId });
  });
}

function resetAlertCooldown() {
  lastAlertAt = 0;
}

async function startSubscription(data = {}) {
  const requestId = uuidv4();
  const started = Date.now();
  const select = data.select === undefined || data.select === null ? DEFAULT_SELECTION : data.select;
  const selection = validateSelection(select);

  logger.info('Subscribe checkout requested', { requestId, plan: selection.planCode, customer: CUSTOMER });
  incrementMetric('subscribe.checkout.attempt', [`customer:${CUSTOMER}`, `plan:${selection.planCode}`]);

  try {
    const checkout = buildCheckout(selection);
    recordTiming('subscribe.checkout.duration', Date.now() - started, [`customer:${CUSTOMER}`]);
    incrementMetric('subscribe.checkout.success', [`customer:${CUSTOMER}`, `plan:${selection.planCode}`]);
    logger.info('Subscribe checkout ready', { requestId, plan: selection.planCode, priceId: checkout.priceId });
    return { success: true, requestId, checkout };
  } catch (error) {
    recordTiming('subscribe.checkout.duration', Date.now() - started, [`customer:${CUSTOMER}`, 'outcome:error']);
    incrementMetric('subscribe.checkout.error', [`customer:${CUSTOMER}`, `error:${error.name}`]);
    logger.error('Subscribe checkout failed', {
      requestId,
      error: error.message,
      errorType: error.name,
      stack: error.stack,
      customer: CUSTOMER,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: 'instant' },
      extra: { requestId, select },
    });

    raiseAlert(error, requestId, { ...data, select, planCode: selection.planCode });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  DEFAULT_SELECTION,
  parseSelection,
  buildCheckout,
  listPlans,
  startSubscription,
  resetAlertCooldown,
};
