const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

/**
 * Full plan catalog, including legacy and regional plans kept for
 * grandfathered subscribers. The self-service portal only sells the first
 * five, but migration rules must consider every plan a subscriber could
 * be coming from or moving to.
 */
const PLAN_CATALOG = [
  { id: 'BASIC-12', name: 'Basic', monthlyRate: 29.99, dataGB: 5, family: 'core' },
  { id: 'PLUS-24', name: 'Plus', monthlyRate: 49.99, dataGB: 15, family: 'core' },
  { id: 'ULTRA-36', name: 'Ultra', monthlyRate: 79.99, dataGB: 50, family: 'core' },
  { id: 'FAMILY-PLUS-12', name: 'Family Plus', monthlyRate: 99.99, dataGB: 100, family: 'core' },
  { id: 'UNLIMITED-24', name: 'Unlimited', monthlyRate: 119.99, dataGB: -1, family: 'core' },
  ...Array.from({ length: 30 }, (_, i) => ({
    id: `LEGACY-${String(i + 1).padStart(2, '0')}`,
    name: `Legacy Plan ${i + 1}`,
    monthlyRate: 19.99 + i * 2.5,
    dataGB: 1 + (i % 12),
    family: i % 3 === 0 ? 'regional' : 'grandfathered',
  })),
];

/**
 * Customer accounts for the demo
 */
const ACCOUNTS = [
  { id: 'CUST-3001', name: 'Alice Chen', currentPlan: 'BASIC-12', dataUsedGB: 3.2, billingDay: 15, phoneNumber: '(555) 123-4567' },
  { id: 'CUST-3002', name: 'Bob Martinez', currentPlan: 'PLUS-24', dataUsedGB: 12.8, billingDay: 1, phoneNumber: '(555) 987-6543' },
  { id: 'CUST-3003', name: 'Carol Nguyen', currentPlan: 'ULTRA-36', dataUsedGB: 42.5, billingDay: 20, phoneNumber: '(555) 456-7890' },
];

/**
 * Score a single migration path (device compatibility, contract-term rules,
 * promo eligibility) via the plan-rules engine (~200ms per pair).
 */
async function scoreMigrationPath(fromPlan, toPlan) {
  await new Promise((resolve) => setTimeout(resolve, 180 + Math.random() * 50));
  const rateDelta = toPlan.monthlyRate - fromPlan.monthlyRate;
  return {
    from: fromPlan.id,
    to: toPlan.id,
    eligible: toPlan.family === 'core',
    score: Math.max(0, 100 - Math.abs(rateDelta)),
  };
}

/**
 * Validate a requested upgrade by ranking it against every migration path
 * available from the subscriber's current plan across the full catalog.
 */
async function rankMigrationPaths(currentPlan) {
  const paths = [];
  for (const candidate of PLAN_CATALOG) {
    paths.push(await scoreMigrationPath(currentPlan, candidate));
  }
  return paths.sort((a, b) => b.score - a.score);
}

/**
 * Calculate the proration for a plan change.
 */
function calculateProration(currentRate, targetRate, billingDay) {
  const today = new Date();
  const currentDay = today.getDate();
  let daysRemaining;
  if (billingDay > currentDay) {
    daysRemaining = billingDay - currentDay;
  } else {
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate();
    daysRemaining = daysInMonth - currentDay + billingDay;
  }
  const dailyDifference = (targetRate - currentRate) / 30;
  return {
    daysRemaining,
    amount: Math.round(dailyDifference * daysRemaining * 100) / 100,
  };
}

/**
 * Upgrade a customer's plan.
 */
async function upgradePlan(data) {
  const startTime = Date.now();
  const upgradeId = uuidv4();

  logger.info('Processing plan upgrade', {
    upgradeId,
    accountId: data.accountId,
    currentPlanCode: data.currentPlanCode,
    targetPlanCode: data.targetPlanCode,
    service: 'telco-api',
    route: '/api/oncall/telco/upgrade',
  });

  try {
    const targetPlan = PLAN_CATALOG.find((p) => p.id === data.targetPlanCode);
    const currentPlan = PLAN_CATALOG.find((p) => p.id === data.currentPlanCode);
    if (!targetPlan || !currentPlan) {
      const err = new Error(`Unknown plan code: ${!targetPlan ? data.targetPlanCode : data.currentPlanCode}`);
      err.code = 'UNKNOWN_PLAN';
      throw err;
    }

    const rankedPaths = await rankMigrationPaths(currentPlan);
    const requestedPath = rankedPaths.find((p) => p.to === targetPlan.id);
    if (!requestedPath || !requestedPath.eligible) {
      const err = new Error(`Plan ${targetPlan.id} is not eligible from ${currentPlan.id}`);
      err.code = 'INELIGIBLE_PLAN';
      throw err;
    }

    const proration = calculateProration(
      currentPlan.monthlyRate,
      targetPlan.monthlyRate,
      data.billingDay || 15,
    );

    const duration = Date.now() - startTime;

    incrementMetric('upgrade.success', {
      route: '/api/oncall/telco/upgrade',
      targetPlan: data.targetPlanCode,
    });
    recordTiming('upgrade.latency', duration, {
      route: '/api/oncall/telco/upgrade',
    });

    logger.info('Plan upgrade completed', {
      upgradeId,
      durationMs: duration,
      pathsEvaluated: rankedPaths.length,
      service: 'telco-api',
    });

    return {
      success: true,
      upgradeId,
      accountId: data.accountId,
      previousPlan: currentPlan.name,
      newPlan: targetPlan.name,
      plan: targetPlan.name,
      monthlyTotal: targetPlan.monthlyRate.toFixed(2),
      discount: (Math.round(targetPlan.monthlyRate * 10) / 100).toFixed(2),
      newTermMonths: parseInt(targetPlan.id.split('-').pop(), 10) || 12,
      prorationCharge: proration.amount,
      newMonthlyRate: targetPlan.monthlyRate,
      newDataGB: targetPlan.dataGB === -1 ? 'Unlimited' : `${targetPlan.dataGB} GB`,
      effectiveDate: new Date().toISOString().split('T')[0],
      status: 'upgraded',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('upgrade.failure', {
      route: '/api/oncall/telco/upgrade',
      errorClass: error.name,
    });
    recordTiming('upgrade.latency', duration, {
      route: '/api/oncall/telco/upgrade',
      error: 'true',
    });

    logger.error('Plan upgrade failed', {
      upgradeId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      accountId: data.accountId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/oncall/telco/upgrade',
        service: 'telco-api',
        targetPlan: data.targetPlanCode,
      },
      extra: { upgradeId, accountId: data.accountId, currentPlan: data.currentPlanCode },
    });

    throw error;
  }
}

module.exports = { upgradePlan, PLAN_CATALOG, ACCOUNTS };
