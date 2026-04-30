const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * 401(k) fund options available for allocation
 */
const FUNDS = [
  { ticker: 'VTTVX', name: 'Target Retirement 2025', category: 'target-date', expenseRatio: 0.08, ytdReturn: 4.2, balance: 28500.00 },
  { ticker: 'VFIFX', name: 'Target Retirement 2050', category: 'target-date', expenseRatio: 0.08, ytdReturn: 8.7, balance: 62300.00 },
  { ticker: 'VFIAX', name: '500 Index Fund Admiral', category: 'domestic-equity', expenseRatio: 0.04, ytdReturn: 12.1, balance: 45800.00 },
  { ticker: 'VTIAX', name: 'Total Intl Stock Index Admiral', category: 'international-equity', expenseRatio: 0.11, ytdReturn: 6.3, balance: 18200.00 },
  { ticker: 'VBTLX', name: 'Total Bond Market Index Admiral', category: 'fixed-income', expenseRatio: 0.05, ytdReturn: 1.8, balance: 22100.00 },
  { ticker: 'VGSLX', name: 'Real Estate Index Fund Admiral', category: 'real-assets', expenseRatio: 0.12, ytdReturn: 3.5, balance: 8400.00 },
];

/**
 * Recent 401(k) activity for display
 */
const ACTIVITY = [
  { id: 'ACT-001', date: '2026-04-15', description: 'Employer Match — Bi-weekly', amount: 375.00, type: 'contribution' },
  { id: 'ACT-002', date: '2026-04-15', description: 'Employee Contribution — Bi-weekly', amount: 750.00, type: 'contribution' },
  { id: 'ACT-003', date: '2026-04-01', description: 'Employer Match — Bi-weekly', amount: 375.00, type: 'contribution' },
  { id: 'ACT-004', date: '2026-04-01', description: 'Employee Contribution — Bi-weekly', amount: 750.00, type: 'contribution' },
  { id: 'ACT-005', date: '2026-03-28', description: 'Dividend Reinvestment — VFIAX', amount: 312.45, type: 'dividend' },
  { id: 'ACT-006', date: '2026-03-15', description: 'Employee Contribution — Bi-weekly', amount: 750.00, type: 'contribution' },
];

/**
 * Risk profile configurations for rebalancing
 */
const RISK_PROFILES = {
  conservative: { equityTarget: 0.30, bondTarget: 0.60, altTarget: 0.10 },
  moderate:     { equityTarget: 0.55, bondTarget: 0.35, altTarget: 0.10 },
  aggressive:   { equityTarget: 0.80, bondTarget: 0.15, altTarget: 0.05 },
};

/**
 * Resolve the risk profile and return allocation targets.
 */
function resolveRiskProfile(profileName) {
  const profile = RISK_PROFILES[profileName];
  if (!profile) return null;
  return { targets: [profile.equityTarget, profile.bondTarget, profile.altTarget] };
}

/**
 * Compute the new allocation amounts based on the profile data.
 */
function computeAllocations(profileData, totalBalance) {
  const equity = profileData.allocation.equity * totalBalance;
  const bonds = profileData.allocation.bonds * totalBalance;
  const alternatives = profileData.allocation.alternatives * totalBalance;
  return { equity, bonds, alternatives };
}

/**
 * Format the rebalance result into a response payload.
 */
function formatRebalanceResult(allocations, totalBalance) {
  return {
    newAllocations: {
      equity: `$${allocations.equity.toFixed(2)}`,
      bonds: `$${allocations.bonds.toFixed(2)}`,
      alternatives: `$${allocations.alternatives.toFixed(2)}`,
    },
    totalBalance: `$${totalBalance.toFixed(2)}`,
    rebalancedAt: new Date().toISOString(),
  };
}

/**
 * Process a 401(k) portfolio rebalance request.
 */
async function processRebalance(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing 401k rebalance', {
    requestId,
    riskProfile: data.riskProfile,
    contributionRate: data.contributionRate,
    service: 'customer-a30498ae-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const totalBalance = FUNDS.reduce((sum, f) => sum + f.balance, 0);
    const profileData = resolveRiskProfile(data.riskProfile);
    const allocations = computeAllocations(profileData, totalBalance);
    const result = formatRebalanceResult(allocations, totalBalance);

    const duration = Date.now() - startTime;

    incrementMetric('rebalance.success', {
      route: '/api/a30498ae/rebalance',
      riskProfile: data.riskProfile,
    });
    recordTiming('rebalance.latency', duration, {
      route: '/api/a30498ae/rebalance',
    });

    return {
      success: true,
      requestId,
      riskProfile: data.riskProfile,
      ...result,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('rebalance.failure', {
      route: '/api/a30498ae/rebalance',
      errorClass: error.name,
      riskProfile: data.riskProfile,
    });
    recordTiming('rebalance.latency', duration, {
      route: '/api/a30498ae/rebalance',
      error: 'true',
    });

    logger.error('Rebalance failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      riskProfile: data.riskProfile,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/a30498ae/rebalance',
        service: 'a30498ae-api',
        riskProfile: data.riskProfile,
      },
      extra: {
        requestId,
        riskProfile: data.riskProfile,
        contributionRate: data.contributionRate,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/a30498ae.js — processRebalance',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'a30498ae-api',
      verticalLabel: '401k Rebalance',
      tags: [
        { key: 'route', value: '/api/a30498ae/rebalance' },
        { key: 'service', value: 'a30498ae-api' },
        { key: 'riskProfile', value: data.riskProfile },
      ],
      extra: { requestId, riskProfile: data.riskProfile, contributionRate: data.contributionRate },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'a30498ae@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from rebalance error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processRebalance, FUNDS, ACTIVITY };
