const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/mobilityplans/purchase';

/**
 * Bring-your-own-phone plan catalog, keyed by plan code.
 */
const PLANS = new Map([
  ['BASIC-5G', { name: '5G Basic', monthlyCents: 4500, dataGB: 20, rateLockTier: 'standard' }],
  ['ESSENTIAL-5G', { name: '5G+ Essential', monthlyCents: 5500, dataGB: 100, rateLockTier: '5g-plus' }],
  ['COMPLETE-5G', { name: '5G+ Complete', monthlyCents: 7000, dataGB: 175, rateLockTier: '5g-plus-us' }],
  ['EXPLORE-5G', { name: '5G+ Complete Explore', monthlyCents: 9000, dataGB: 250, rateLockTier: '5g-plus-intl' }],
]);

/**
 * Rate Plan Price Lock schedule from pricing ops, keyed by rate-lock tier.
 */
const RATE_LOCK_TERMS = new Map([
  ['standard', { lockMonths: 24, label: '2-Year Price Lock' }],
  ['5g-plus', { lockMonths: 60, label: '5-Year Rate Plan Price Lock' }],
  ['5g-plus-intl', { lockMonths: 60, label: '5-Year Rate Plan Price Lock' }],
]);

const ADDONS = new Map([
  ['none', { name: null, monthlyCents: 0 }],
  ['international', { name: 'Easy Roam', monthlyCents: 0 }],
  ['hotspot', { name: 'Data top-up 10 GB', monthlyCents: 1000 }],
  ['insurance', { name: 'Device Care', monthlyCents: 1200 }],
]);

function addMonths(date, months) {
  const d = new Date(date.getTime());
  d.setUTCMonth(d.getUTCMonth() + months);
  return d;
}

function priceLockFor(plan, startDate) {
  const terms = RATE_LOCK_TERMS.get(plan.rateLockTier);
  return {
    label: terms.label,
    lockedMonthlyCents: plan.monthlyCents,
    lockedUntil: addMonths(startDate, terms.lockMonths).toISOString().slice(0, 10),
  };
}

/**
 * Buy a new mobility plan for an existing line.
 */
async function purchasePlan(data, options = {}) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing plan purchase', {
    orderId,
    accountId: data.accountId,
    currentPlanCode: data.currentPlanCode,
    planCode: data.planCode,
    addon: data.addon,
    service: 'plans-api',
    route: ROUTE,
  });

  try {
    const plan = PLANS.get(data.planCode);
    if (!plan) {
      const error = new Error(`Unknown plan: ${data.planCode}`);
      error.code = 'PLAN_NOT_FOUND';
      throw error;
    }
    if (data.planCode === data.currentPlanCode) {
      const error = new Error('Line is already on this plan');
      error.code = 'SAME_PLAN';
      throw error;
    }
    const addon = ADDONS.get(data.addon) || ADDONS.get('none');

    const effectiveDate = new Date();
    const priceLock = priceLockFor(plan, effectiveDate);
    const monthlyCents = plan.monthlyCents + addon.monthlyCents;
    const duration = Date.now() - startTime;

    incrementMetric('plans.purchase.success', { route: ROUTE });
    recordTiming('plans.purchase.latency', duration, { route: ROUTE });

    return {
      success: true,
      orderId,
      accountId: data.accountId,
      planCode: data.planCode,
      plan: plan.name,
      dataGB: plan.dataGB,
      addon: addon.name,
      monthlyTotal: (monthlyCents / 100).toFixed(2),
      priceLock,
      effectiveDate: effectiveDate.toISOString().slice(0, 10),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('plans.purchase.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('plans.purchase.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Plan purchase failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
      planCode: data.planCode,
      currentPlanCode: data.currentPlanCode,
    });

    if (!error.code) {
      Sentry.captureException(error, {
        tags: {
          route: ROUTE,
          service: 'plans-api',
          ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
        },
        extra: { orderId, planCode: data.planCode, currentPlanCode: data.currentPlanCode },
      });
    }

    throw error;
  }
}

module.exports = { purchasePlan, PLANS, RATE_LOCK_TERMS };
