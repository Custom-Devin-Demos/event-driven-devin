const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Retirement fund holdings for the demo
 */
const FUND_HOLDINGS = [
  { id: 'FUND-001', ticker: 'QCSTIX', name: 'CREF Stock Account R3', category: 'Large Cap Blend', balance: 87420.15, shares: 2145.32, returnYTD: 8.4 },
  { id: 'FUND-002', ticker: 'TIORX', name: 'TIAA Real Estate Account', category: 'Real Estate', balance: 34810.00, shares: 1892.10, returnYTD: 2.1 },
  { id: 'FUND-003', ticker: 'TLIRX', name: 'TIAA-CREF Lifecycle 2040 Retire', category: 'Target Date', balance: 62500.75, shares: 4230.50, returnYTD: 6.9 },
  { id: 'FUND-004', ticker: 'QCBMIX', name: 'CREF Bond Market Account R3', category: 'Intermediate Bond', balance: 28300.40, shares: 2810.60, returnYTD: 1.8 },
  { id: 'FUND-005', ticker: 'QCILIX', name: 'CREF Inflation-Linked Bond R3', category: 'Inflation-Protected', balance: 15670.90, shares: 1540.25, returnYTD: 3.2 },
  { id: 'FUND-006', ticker: 'TIDRX', name: 'TIAA Traditional Annuity', category: 'Stable Value', balance: 41200.00, shares: 41200.00, returnYTD: 4.0 },
];

/**
 * Contribution history for display
 */
const CONTRIBUTIONS = [
  { id: 'CTB-001', date: '2026-04-15', source: 'Employee Pre-Tax', amount: 865.38, payPeriod: 'Bi-Weekly' },
  { id: 'CTB-002', date: '2026-04-15', source: 'Employer Match', amount: 432.69, payPeriod: 'Bi-Weekly' },
  { id: 'CTB-003', date: '2026-04-01', source: 'Employee Pre-Tax', amount: 865.38, payPeriod: 'Bi-Weekly' },
  { id: 'CTB-004', date: '2026-04-01', source: 'Employer Match', amount: 432.69, payPeriod: 'Bi-Weekly' },
  { id: 'CTB-005', date: '2026-03-15', source: 'Employee Pre-Tax', amount: 865.38, payPeriod: 'Bi-Weekly' },
  { id: 'CTB-006', date: '2026-03-15', source: 'Employer Match', amount: 432.69, payPeriod: 'Bi-Weekly' },
];

/**
 * Target allocation model by risk profile
 */
const ALLOCATION_MODELS = {
  aggressive:   { equityPct: 0.85, bondPct: 0.10, stablePct: 0.05 },
  moderate:     { equityPct: 0.60, bondPct: 0.25, stablePct: 0.15 },
  conservative: { equityPct: 0.35, bondPct: 0.40, stablePct: 0.25 },
};

/**
 * Resolve the target allocation for a given risk profile.
 * Returns targets as a flat array — NOT nested under .allocation.
 */
function resolveTargetAllocation(riskProfile) {
  const model = ALLOCATION_MODELS[riskProfile];
  if (!model) return null;
  return {
    targets: [
      { assetClass: 'equity', weight: model.equityPct },
      { assetClass: 'bond', weight: model.bondPct },
      { assetClass: 'stable', weight: model.stablePct },
    ],
  };
}

/**
 * Compute rebalance actions from the resolved allocation data.
 * Expects allocationData.allocation.equity — but the resolver
 * returns { targets: [...] } instead, causing a TypeError.
 */
function computeRebalanceActions(allocationData, totalBalance) {
  const equityTarget = allocationData.allocation.equity * totalBalance;
  const bondTarget = allocationData.allocation.bond * totalBalance;
  const stableTarget = totalBalance - equityTarget - bondTarget;

  return {
    actions: [
      { assetClass: 'Equity', targetAmount: equityTarget.toFixed(2) },
      { assetClass: 'Fixed Income', targetAmount: bondTarget.toFixed(2) },
      { assetClass: 'Stable Value', targetAmount: stableTarget.toFixed(2) },
    ],
  };
}

/**
 * Format the rebalance summary for the response payload.
 */
function formatRebalanceSummary(rebalanceResult, requestMeta) {
  return {
    planId: `RBL-${Date.now()}`,
    account: requestMeta.accountId,
    riskProfile: requestMeta.riskProfile,
    actions: rebalanceResult.actions,
    effectiveDate: new Date().toISOString(),
  };
}

/**
 * Process a 401(k) portfolio rebalance request.
 */
async function processRebalance(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing rebalance request', {
    requestId,
    accountId: data.accountId,
    riskProfile: data.riskProfile,
    service: '766718e2-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const totalBalance = FUND_HOLDINGS.reduce((sum, f) => sum + f.balance, 0);
    const allocationData = resolveTargetAllocation(data.riskProfile);
    const rebalanceResult = computeRebalanceActions(allocationData, totalBalance);
    const summary = formatRebalanceSummary(rebalanceResult, data);

    const duration = Date.now() - startTime;

    incrementMetric('rebalance.success', {
      route: '/api/766718e2/rebalance',
      riskProfile: data.riskProfile,
    });
    recordTiming('rebalance.latency', duration, {
      route: '/api/766718e2/rebalance',
    });

    return {
      success: true,
      requestId,
      ...summary,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('rebalance.failure', {
      route: '/api/766718e2/rebalance',
      errorClass: error.name,
      riskProfile: data.riskProfile,
    });
    recordTiming('rebalance.latency', duration, {
      route: '/api/766718e2/rebalance',
      error: 'true',
    });

    logger.error('Rebalance failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      accountId: data.accountId,
      riskProfile: data.riskProfile,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/766718e2/rebalance',
        service: '766718e2-api',
        riskProfile: data.riskProfile,
      },
      extra: {
        requestId,
        accountId: data.accountId,
        riskProfile: data.riskProfile,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/766718e2.js — processRebalance',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: '766718e2-api',
      verticalLabel: '401(k) Rebalance',
      tags: [
        { key: 'route', value: '/api/766718e2/rebalance' },
        { key: 'service', value: '766718e2-api' },
        { key: 'riskProfile', value: data.riskProfile },
      ],
      extra: { requestId, accountId: data.accountId, riskProfile: data.riskProfile },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '766718e2@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processRebalance, FUND_HOLDINGS, CONTRIBUTIONS };
