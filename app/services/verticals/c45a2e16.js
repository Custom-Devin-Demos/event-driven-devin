const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'checkout-plans-api';

// Instalment schedules the checkout can build. A plan the shopper picks is
// resolved through the tenant's planCodes to one of these keys.
const INSTALMENT_PLANS = {
  pay_in_4: { label: 'Pay in 4', instalments: 4, intervalMonths: 1, upfrontShare: 0.25 },
  pay_in_6: { label: 'Pay in 6', instalments: 6, intervalMonths: 1, upfrontShare: 1 / 6 },
  pay_in_12: { label: 'Pay in 12', instalments: 12, intervalMonths: 1, upfrontShare: 1 / 12 },
};

/**
 * One tenant per demo owner. Each tenant owns the order on its checkout and
 * its own schedule key for the Pay in 24 launch, so registering one tenant's
 * schedule leaves every other tenant's Pay in 24 checkout failing as before.
 *
 * There is deliberately no shared or default tenant: the checkout is reachable
 * only at /c45a2e16/<slug>. Add an owner with an entry here and an unused
 * Pay in 24 schedule key.
 */
const TENANTS = {
  nouf: {
    slug: 'nouf',
    label: 'Pay with Tamara — Checkout plan (Nouf)',
    order: {
      orderRef: 'TMR-ORD-7731-20582',
      merchant: 'Riyadh Tech Store',
      item: 'iPhone 16 Pro, 256 GB, Desert Titanium',
      amount: 5499,
      currency: 'SAR',
    },
    planCodes: {
      pay_in_4: 'pay_in_4',
      pay_in_6: 'pay_in_6',
      pay_in_12: 'pay_in_12',
      // Pay in 24 launched on this checkout in 2026
      pay_in_24: 'pay_in_24_nouf',
    },
  },
};

function getTenant(slug) {
  const key = String(slug || '').trim().toLowerCase();
  return Object.hasOwn(TENANTS, key) ? TENANTS[key] : undefined;
}

function routeTag(tenant) {
  return `/api/c45a2e16/${tenant.slug}/checkout`;
}

const SLACK_MEMBER_ID = process.env.SLACK_MEMBER_ID_C45A2E16 || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved resolveInstalmentSchedule';

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the checkout plan failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues; ignore every issue that is not from the checkout route named in the alert's route tag and do not modify any other vertical. The failing surface is the BNPL checkout at app/public/verticals/c45a2e16.html, served per demo owner at GET /c45a2e16/<tenant>, whose "Confirm and pay" action posts to POST /api/c45a2e16/<tenant>/checkout in app/routes/verticals/c45a2e16.js. The checkout pipeline lives in app/services/verticals/c45a2e16.js: confirmCheckout -> buildPaymentPlan -> resolveInstalmentSchedule. resolveInstalmentSchedule looks up INSTALMENT_PLANS by the schedule key the tenant's planCodes map the chosen plan to, so a plan whose schedule was never registered cannot be confirmed. Use the schedule key named in the alert's plan_schedule tag as the remediation target: register that schedule (label, number of instalments, months between instalments, share paid today) and keep unregistered schedules failing as a handled configuration error rather than a TypeError. Verify by starting the server (node app/server.js) and confirming the affected tenant's checkout with that plan, which must return a confirmed payment plan, and confirm npm run lint and npm test pass.

The checkout is served per demo owner: every tenant declared in TENANTS is reachable only at /c45a2e16/<slug> with POST /api/c45a2e16/<slug>/checkout, and there is no shared or default tenant. Each tenant owns its own order and Pay in 24 schedule key, so register only the schedule named in the alert's plan_schedule tag and leave every other tenant untouched.

Verification evidence is mandatory and must be visual, not curl-only: with the server running, open the checkout for the affected tenant in a real browser, choose the affected plan, click "Confirm and pay", and record your screen for the whole attempt so the recording shows the plan choice, the click, and the confirmed payment plan that replaces the previous error. Attach a screenshot and an animated webp of the recording to the pull request under a "Fix Verification" heading.`;

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function resolveInstalmentSchedule(scheduleKey) {
  const plan = INSTALMENT_PLANS[scheduleKey];
  return {
    label: plan.label,
    instalments: plan.instalments,
    intervalMonths: plan.intervalMonths,
    upfrontShare: plan.upfrontShare,
  };
}

function addMonths(date, months) {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(date.getUTCDate(), lastDay)));
}

function buildPaymentPlan(order, scheduleKey, now = new Date()) {
  const schedule = resolveInstalmentSchedule(scheduleKey);
  const totalHalalas = Math.round(order.amount * 100);
  const todayHalalas = Math.round(totalHalalas * schedule.upfrontShare);
  const remaining = schedule.instalments - 1;
  const base = remaining > 0 ? Math.floor((totalHalalas - todayHalalas) / remaining) : 0;
  let leftover = totalHalalas - todayHalalas - base * remaining;

  const payments = [{ dueDate: now.toISOString().slice(0, 10), amount: todayHalalas / 100 }];
  for (let i = 1; i <= remaining; i += 1) {
    const extra = leftover > 0 ? 1 : 0;
    leftover -= extra;
    payments.push({
      dueDate: addMonths(now, i * schedule.intervalMonths).toISOString().slice(0, 10),
      amount: (base + extra) / 100,
    });
  }

  return {
    checkoutId: `TMR-${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`,
    orderRef: order.orderRef,
    merchant: order.merchant,
    plan: schedule.label,
    instalments: schedule.instalments,
    total: order.amount,
    currency: order.currency,
    payToday: payments[0].amount,
    payments,
    confirmedAt: now.toISOString(),
  };
}

async function confirmCheckout(data) {
  const startTime = Date.now();
  const tenant = getTenant(data.tenant);

  if (!tenant) {
    throw validationError(`Unknown checkout tenant "${data.tenant}"`, 'UNKNOWN_TENANT');
  }

  const { order } = tenant;
  if (data.orderRef && data.orderRef !== order.orderRef) {
    throw validationError('Unknown order', 'UNKNOWN_ORDER');
  }

  const planCode = String(data.plan || '');
  if (!Object.hasOwn(tenant.planCodes, planCode)) {
    throw validationError('Choose a payment plan', 'UNKNOWN_PLAN');
  }
  const scheduleKey = tenant.planCodes[planCode];

  logger.info('Confirming checkout plan', {
    orderRef: order.orderRef,
    plan: planCode,
    planSchedule: scheduleKey,
    service: SERVICE,
    route: routeTag(tenant),
  });

  try {
    const checkout = buildPaymentPlan(order, scheduleKey);
    recordTiming('checkout.plan.latency', Date.now() - startTime, { route: routeTag(tenant), plan: planCode });
    incrementMetric('checkout.plan.success', { route: routeTag(tenant), plan: planCode });
    return { success: true, checkout };
  } catch (error) {
    if (error.statusCode === 400) throw error;
    const duration = Date.now() - startTime;

    incrementMetric('checkout.plan.failure', {
      route: routeTag(tenant),
      errorClass: error.name,
      plan: planCode,
      planSchedule: scheduleKey,
    });
    recordTiming('checkout.plan.latency', duration, { route: routeTag(tenant), plan: planCode, error: 'true' });

    logger.error('Checkout plan confirmation failed', {
      orderRef: order.orderRef,
      plan: planCode,
      planSchedule: scheduleKey,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: routeTag(tenant),
        service: SERVICE,
        plan: planCode,
        plan_schedule: scheduleKey,
        alert_path: 'instant',
      },
      extra: { orderRef: order.orderRef, plan: planCode, planSchedule: scheduleKey },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/c45a2e16.js — resolveInstalmentSchedule',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: SERVICE,
      verticalLabel: tenant.label,
      customer: 'c45a2e16',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: routeTag(tenant) },
        { key: 'service', value: SERVICE },
        { key: 'plan', value: planCode },
        { key: 'plan_schedule', value: scheduleKey },
      ],
      extra: { orderRef: order.orderRef, plan: planCode, planSchedule: scheduleKey },
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
      logger.error('Failed to create Devin session for checkout plan error', {
        orderRef: order.orderRef,
        error: alertError.message,
      });
    });

    throw error;
  }
}

module.exports = {
  confirmCheckout,
  buildPaymentPlan,
  resolveInstalmentSchedule,
  getTenant,
  TENANTS,
  INSTALMENT_PLANS,
  REMEDIATION_DIRECTIVE,
};
