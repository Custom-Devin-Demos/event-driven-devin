const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Mobile plans for the demo
 */
const PLANS = [
  { id: 'BASIC-12', name: 'Basic', monthlyRate: 29.99, dataGB: 5 },
  { id: 'PLUS-24', name: 'Plus', monthlyRate: 49.99, dataGB: 15 },
  { id: 'ULTRA-36', name: 'Ultra', monthlyRate: 79.99, dataGB: 50 },
  { id: 'FAMILY-PLUS-12', name: 'Family Plus', monthlyRate: 99.99, dataGB: 100 },
  { id: 'UNLIMITED-24', name: 'Unlimited', monthlyRate: 119.99, dataGB: -1 },
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
 * Parse a plan code into its components.
 * Plan codes follow the format: NAME-TERM (e.g., "BASIC-12", "PLUS-24")
 */
function parsePlanCode(planCode) {
  const segments = planCode.split('-');
  const termMonths = parseInt(segments.pop(), 10);
  const planName = segments.join('-');
  return { planName, termMonths };
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
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const targetParsed = parsePlanCode(data.targetPlanCode);
    const currentParsed = parsePlanCode(data.currentPlanCode);

    const targetPlan = PLANS.find((p) => p.code === targetParsed.planName);
    const currentPlan = PLANS.find((p) => p.code === currentParsed.planName);

    const proration = calculateProration(
      currentPlan.monthlyRate,
      targetPlan.monthlyRate,
      data.billingDay || 15,
    );

    const duration = Date.now() - startTime;

    incrementMetric('upgrade.success', {
      route: '/api/telco/upgrade',
      targetPlan: data.targetPlanCode,
    });
    recordTiming('upgrade.latency', duration, {
      route: '/api/telco/upgrade',
    });

    return {
      success: true,
      upgradeId,
      accountId: data.accountId,
      previousPlan: currentParsed.planName,
      newPlan: targetParsed.planName,
      newTermMonths: targetParsed.termMonths,
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
      route: '/api/telco/upgrade',
      errorClass: error.name,
    });
    recordTiming('upgrade.latency', duration, {
      route: '/api/telco/upgrade',
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
        route: '/api/telco/upgrade',
        service: 'telco-api',
        targetPlan: data.targetPlanCode,
      },
      extra: { upgradeId, accountId: data.accountId, currentPlan: data.currentPlanCode },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/telco.js — upgradePlan',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'telco-api',
      verticalLabel: 'Plan Upgrade',
      tags: [
        { key: 'route', value: '/api/telco/upgrade' },
        { key: 'service', value: 'telco-api' },
      ],
      extra: { upgradeId, accountId: data.accountId, targetPlanCode: data.targetPlanCode },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'waveconnect@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from upgrade error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { upgradePlan, PLANS, ACCOUNTS };
