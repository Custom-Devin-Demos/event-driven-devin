const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Subscription plan catalog with billing configuration.
 */
const PLANS = {
  photography: { code: 'PHOTO', monthly: 19.99, apps: 3, storageGb: 20 },
  single_app: { code: 'SINGLE', monthly: 22.99, apps: 1, storageGb: 100 },
  all_apps: { code: 'PRO', monthly: 69.99, apps: 20, storageGb: 100, promo: { discountRate: 0.5, months: 3 } },
  teams: { code: 'TEAM', monthly: 89.99, apps: 20, storageGb: 1024, promo: { discountRate: 0.25, months: 2 } },
};

/**
 * Optional add-ons available at checkout.
 */
const ADDONS = [
  { id: 'stock', label: 'Stock Standard Assets', monthly: 29.99 },
  { id: 'firefly-credits', label: 'Generative AI Credit Pack', monthly: 9.99 },
  { id: 'extra-storage', label: 'Additional 1TB Storage', monthly: 9.99 },
];

function findPlan(planId) {
  return PLANS[planId] || PLANS.single_app;
}

/**
 * Compute the base billing breakdown for a plan.
 */
function computeBilling(plan, billingCycle, seats) {
  const cycleMultiplier = billingCycle === 'annual' ? 12 : 1;
  const subtotal = plan.monthly * cycleMultiplier * seats;
  const tax = subtotal * 0.0875;

  return {
    planCode: plan.code,
    monthlyRate: plan.monthly,
    cycleMultiplier,
    subtotal: Math.round(subtotal * 100) / 100,
    tax: Math.round(tax * 100) / 100,
    includedApps: plan.apps,
    storageGb: plan.storageGb,
    promo: plan.promo,
  };
}

/**
 * Build the introductory offer summary applied to the first billing cycle.
 */
function buildIntroOffer(billing, seats) {
  const promo = billing.promo || { discountRate: 0, months: 0 };
  const discountedMonthly = billing.monthlyRate * (1 - promo.discountRate);
  const savings = (billing.monthlyRate - discountedMonthly) * promo.months * seats;

  return {
    discountedMonthly: Math.round(discountedMonthly * 100) / 100,
    promoMonths: promo.months,
    totalSavings: Math.round(savings * 100) / 100,
  };
}

/**
 * Assemble the final order summary presented to the customer.
 */
function assembleOrderSummary(billing, introOffer, seats, addons) {
  const addonTotal = addons.reduce((sum, a) => sum + a.monthly, 0);
  const firstCycleTotal = introOffer.discountedMonthly * seats + addonTotal + billing.tax;

  return {
    planCode: billing.planCode,
    seats,
    monthlyRate: billing.monthlyRate,
    discountedMonthly: introOffer.discountedMonthly,
    promoMonths: introOffer.promoMonths,
    totalSavings: introOffer.totalSavings,
    includedApps: billing.includedApps,
    storageGb: billing.storageGb,
    addons: addons.map((a) => ({ label: a.label, monthly: a.monthly })),
    addonTotal: Math.round(addonTotal * 100) / 100,
    firstCycleTotal: Math.round(firstCycleTotal * 100) / 100,
  };
}

/**
 * Processes a subscription order request.
 */
async function processSubscription(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing subscription order', {
    requestId,
    plan: data.plan,
    billingCycle: data.billingCycle,
    service: 'customer-b634a963-plans',
    route: '/api/b634a963/subscribe',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const plan = findPlan(data.plan);
    const billing = computeBilling(plan, data.billingCycle, data.seats);
    const introOffer = buildIntroOffer(billing, data.seats);
    const selectedAddons = (data.addons || [])
      .map((id) => ADDONS.find((a) => a.id === id))
      .filter(Boolean);
    const summary = assembleOrderSummary(billing, introOffer, data.seats, selectedAddons);

    summary.requestId = requestId;
    summary.orderedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('subscription_order.success', {
      route: '/api/b634a963/subscribe',
      plan: data.plan,
    });
    recordTiming('subscription_order.latency', duration, {
      route: '/api/b634a963/subscribe',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('subscription_order.failure', {
      route: '/api/b634a963/subscribe',
      errorClass: error.name,
    });
    recordTiming('subscription_order.latency', duration, {
      route: '/api/b634a963/subscribe',
      error: 'true',
    });

    logger.error('Subscription order failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      plan: data.plan,
      billingCycle: data.billingCycle,
      service: 'customer-b634a963-plans',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/b634a963/subscribe',
        service: 'customer-b634a963-plans',
        plan: data.plan,
      },
      extra: { requestId, plan: data.plan, billingCycle: data.billingCycle },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b634a963.js \u2014 buildIntroOffer',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-b634a963-plans',
      verticalLabel: 'Subscription Order',
      customer: 'b634a963',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/b634a963/subscribe' },
        { key: 'service', value: 'customer-b634a963-plans' },
        { key: 'plan', value: data.plan },
      ],
      extra: { requestId, plan: data.plan, billingCycle: data.billingCycle },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-b634a963-plans@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for subscription order error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  processSubscription,
  buildIntroOffer,
  computeBilling,
  findPlan,
  PLANS,
  ADDONS,
};
