/**
 * Customer 4d820a2b — wireless switch offer service.
 *
 * Prices the "Start your switch" offer from the homepage hero: resolves the
 * active device promotion, picks the recommended rate plan for the default
 * household size, applies the plan's switcher bill-credit schedule and returns
 * a quote summary the page can hand off to checkout.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER = '4d820a2b';
const SERVICE = 'customer-4d820a2b-switch';
const ROUTE = '/api/4d820a2b/inquiry';
const RELEASE = 'switch-offers@3.8.1';
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS_4D820A2B) || 60 * 1000;

const OWNER = Object.freeze({
  slackMemberId: 'U0AU1PXM12S',
  devinUserId: 'okta|Cognition|00u22b98f2kFBX4Al1d8',
  devinOrgId: 'org-cba5887ae1534949b9696649e27367ad',
});

const RATE_PLANS = [
  {
    code: 'EXP_BEYOND_2',
    name: 'Experience Beyond 2.0',
    tier: 'premium',
    perLineMonthly: 56.67,
    linesIncluded: 3,
    priceLockYears: 5,
  },
  {
    code: 'EXP_MORE_2',
    name: 'Experience More 2.0',
    tier: 'core',
    perLineMonthly: 46.67,
    linesIncluded: 3,
    priceLockYears: 5,
  },
  {
    code: 'ESSENTIALS_2',
    name: 'Essentials 2.0',
    tier: 'value',
    perLineMonthly: 30.0,
    linesIncluded: 3,
    priceLockYears: 0,
  },
];

const PROMOTIONS = [
  {
    id: 'switch-iphone18pro',
    title: 'Get up to $1,000 off iPhone 18 Pro.',
    device: { sku: 'APL-IP18P-256-CSL', name: 'iPhone 18 Pro 256GB', retail: 1099.99 },
    requiresPortIn: true,
    eligiblePlans: ['EXP_BEYOND_2', 'EXP_MORE_2'],
    termMonths: 36,
  },
  {
    id: 'switch-keep-your-phone',
    title: 'Keep your phone. Plans start at $30/mo.',
    device: null,
    requiresPortIn: true,
    eligiblePlans: ['ESSENTIALS_2', 'EXP_MORE_2', 'EXP_BEYOND_2'],
    termMonths: 0,
  },
];

const BILL_CREDIT_SCHEDULES = {
  EXPERIENCE_BEYOND: { maxCredit: 1000, monthlyCredit: 27.78, months: 36, portInBonus: 0 },
  EXPERIENCE_MORE: { maxCredit: 830, monthlyCredit: 23.06, months: 36, portInBonus: 0 },
  ESSENTIALS: { maxCredit: 0, monthlyCredit: 0, months: 0, portInBonus: 0 },
};

const LINE_FEES = {
  EXPERIENCE_BEYOND: { autopayDiscount: 5, taxesIncluded: true, connectionCharge: 0 },
  EXPERIENCE_MORE: { autopayDiscount: 5, taxesIncluded: true, connectionCharge: 0 },
  ESSENTIALS: { autopayDiscount: 5, taxesIncluded: false, connectionCharge: 35 },
};

const DEFAULT_LINES = 3;
const MAX_LINES = 12;

let lastAlertAt = 0;

function money(value) {
  return Math.round(value * 100) / 100;
}

function listOffers() {
  return {
    plans: RATE_PLANS.map((plan) => ({
      code: plan.code,
      name: plan.name,
      perLineMonthly: plan.perLineMonthly,
      linesIncluded: plan.linesIncluded,
    })),
    promotions: PROMOTIONS.map((promo) => ({ id: promo.id, title: promo.title })),
  };
}

function findPromotion(promotionId) {
  const promo = PROMOTIONS.find((p) => p.id === promotionId);
  if (!promo) {
    const error = new Error(`Unknown promotion: ${promotionId}`);
    error.statusCode = 404;
    error.code = 'PROMOTION_NOT_FOUND';
    throw error;
  }
  return promo;
}

function recommendedPlan(promo) {
  const eligible = RATE_PLANS.filter((plan) => promo.eligiblePlans.includes(plan.code));
  return eligible.sort((a, b) => b.perLineMonthly - a.perLineMonthly)[0];
}

function creditScheduleFor(plan) {
  return BILL_CREDIT_SCHEDULES[plan.code];
}

function lineFeesFor(plan) {
  return LINE_FEES[plan.code];
}

function applySwitchCredits(promo, plan) {
  const schedule = creditScheduleFor(plan);
  if (!promo.device) {
    return { deviceCredit: 0, monthlyCredit: 0, months: 0 };
  }
  const deviceCredit = Math.min(schedule.maxCredit, promo.device.retail);
  return {
    deviceCredit,
    monthlyCredit: schedule.monthlyCredit,
    months: schedule.months,
    portInBonus: promo.requiresPortIn ? schedule.portInBonus : 0,
  };
}

function priceLines(plan, lines) {
  const fees = lineFeesFor(plan);
  const base = plan.perLineMonthly * lines;
  return {
    monthlyWithAutoPay: money(base),
    monthlyWithoutAutoPay: money(base + fees.autopayDiscount * lines),
    oneTimeCharges: money(fees.connectionCharge * lines),
    taxesIncluded: fees.taxesIncluded,
  };
}

function buildSwitchQuote(promotionId, lines = DEFAULT_LINES) {
  const promo = findPromotion(promotionId);
  const plan = recommendedPlan(promo);
  const credits = applySwitchCredits(promo, plan);
  const pricing = priceLines(plan, lines);
  const devicePerMonth = promo.device && promo.termMonths
    ? money((promo.device.retail - credits.deviceCredit) / promo.termMonths)
    : 0;

  return {
    promotionId: promo.id,
    plan: { code: plan.code, name: plan.name, priceLockYears: plan.priceLockYears },
    lines,
    device: promo.device ? { sku: promo.device.sku, name: promo.device.name } : null,
    credits,
    pricing,
    devicePerMonth,
    estimatedMonthly: money(pricing.monthlyWithAutoPay + devicePerMonth * (promo.device ? 1 : 0)),
  };
}

function sentryIssueUrl() {
  const org = process.env.SENTRY_ORG_SLUG || 'sentry-org';
  const project = process.env.SENTRY_PROJECT_ID || '';
  return `https://${org}.sentry.io/issues/?project=${project}&query=is%3Aunresolved`;
}

function raiseAlert(error, requestId, data) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
    logger.warn('Switch offer alert suppressed by cooldown', { requestId, cooldownMs: ALERT_COOLDOWN_MS });
    return;
  }
  lastAlertAt = now;

  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: sentryIssueUrl(),
    culprit: 'app/services/verticals/4d820a2b.js in buildSwitchQuote',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: data.devinUserId || OWNER.devinUserId,
    devinOrgId: data.devinOrgId || OWNER.devinOrgId,
    devinEmail: data.devinEmail,
    slackMemberId: OWNER.slackMemberId,
    service: SERVICE,
    verticalLabel: 'Wireless Switch Offer',
    customer: CUSTOMER,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'promotion', value: data.promotionId },
    ],
    extra: { requestId, promotionId: data.promotionId, lines: data.lines },
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
    logger.error('Failed to raise alert for switch offer failure', { error: alertError.message, requestId });
  });
}

function resetAlertCooldown() {
  lastAlertAt = 0;
}

async function processInquiry(data = {}) {
  const requestId = uuidv4();
  const started = Date.now();
  const promotionId = data.promotionId || 'switch-iphone18pro';
  const lines = Number.isInteger(data.lines) && data.lines > 0 && data.lines <= MAX_LINES ? data.lines : DEFAULT_LINES;
  findPromotion(promotionId);

  logger.info('Switch offer inquiry received', { requestId, promotionId, lines, customer: CUSTOMER });
  incrementMetric('switch.inquiry.attempt', [`customer:${CUSTOMER}`, `promotion:${promotionId}`]);

  try {
    const quote = buildSwitchQuote(promotionId, lines);
    recordTiming('switch.inquiry.duration', Date.now() - started, [`customer:${CUSTOMER}`]);
    incrementMetric('switch.inquiry.success', [`customer:${CUSTOMER}`]);
    logger.info('Switch offer quote built', { requestId, plan: quote.plan.code });
    return { success: true, requestId, quote };
  } catch (error) {
    if (error.statusCode && error.statusCode < 500) throw error;

    recordTiming('switch.inquiry.duration', Date.now() - started, [`customer:${CUSTOMER}`, 'outcome:error']);
    incrementMetric('switch.inquiry.error', [`customer:${CUSTOMER}`, `error:${error.name}`]);
    logger.error('Switch offer inquiry failed', {
      requestId,
      error: error.message,
      errorType: error.name,
      stack: error.stack,
      customer: CUSTOMER,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: 'instant' },
      extra: { requestId, promotionId, lines },
    });

    raiseAlert(error, requestId, { ...data, promotionId, lines });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  RATE_PLANS,
  PROMOTIONS,
  listOffers,
  buildSwitchQuote,
  processInquiry,
  resetAlertCooldown,
};
