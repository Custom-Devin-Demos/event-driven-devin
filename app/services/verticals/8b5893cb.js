const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Managed-account holdings for the demo portfolio.
 */
const HOLDINGS = [
  { symbol: 'PRGFX', name: 'Growth Stock Fund', assetClass: 'US Equity', marketValue: 482300.55, targetWeight: 0.38, currentWeight: 0.44 },
  { symbol: 'PRWCX', name: 'Capital Appreciation Fund', assetClass: 'Multi-Asset', marketValue: 268900.10, targetWeight: 0.22, currentWeight: 0.245 },
  { symbol: 'RPMGX', name: 'Mid-Cap Growth Fund', assetClass: 'US Equity', marketValue: 142500.00, targetWeight: 0.12, currentWeight: 0.13 },
  { symbol: 'PRNHX', name: 'New Horizons Fund', assetClass: 'US Equity', marketValue: 98200.40, targetWeight: 0.08, currentWeight: 0.089 },
  { symbol: 'RPSIX', name: 'Spectrum Income Fund', assetClass: 'Fixed Income', marketValue: 96000.00, targetWeight: 0.15, currentWeight: 0.087 },
  { symbol: 'TRBUX', name: 'Ultra Short-Term Bond Fund', assetClass: 'Cash & Equivalents', marketValue: 11000.00, targetWeight: 0.05, currentWeight: 0.009 },
];

/**
 * Advisory program fee schedules.
 *
 * NOTE: The "private-asset-mgmt" program is a negotiated institutional
 * relationship whose advisory fee is billed out-of-band, so its feeSchedule
 * is intentionally null. The rebalance flow is expected to short-circuit the
 * fee calculation for this program before reading any schedule properties —
 * but calculateAdvisoryFee reads the schedule unconditionally.
 */
const ADVISORY_PROGRAMS = {
  'private-asset-mgmt': { name: 'Private Asset Management', feeSchedule: null },
  select: { name: 'Personal Strategy — Select', feeSchedule: { annualBps: 70, minimumFee: 250 } },
  preferred: { name: 'Personal Strategy — Preferred', feeSchedule: { annualBps: 55, minimumFee: 150 } },
  standard: { name: 'Personal Strategy — Standard', feeSchedule: { annualBps: 90, minimumFee: 300 } },
};

/**
 * Resolve the advisory program configuration.
 */
function resolveAdvisoryProgram(programId) {
  const config = ADVISORY_PROGRAMS[programId];
  if (!config) return null;
  return { config };
}

/**
 * Compute the annual advisory fee for the portfolio under the resolved program.
 * BUG: For "private-asset-mgmt", feeSchedule is null because the fee is billed
 * out-of-band. Reading .annualBps on null throws a TypeError.
 */
function calculateAdvisoryFee(programData, portfolioValue) {
  const schedule = programData.config.feeSchedule;
  const fee = (portfolioValue * schedule.annualBps) / 10000;
  return Math.max(fee, schedule.minimumFee);
}

/**
 * Build the list of rebalance trades needed to bring holdings back to target.
 */
function buildRebalanceTrades(portfolioValue) {
  return HOLDINGS.map((h) => {
    const targetValue = portfolioValue * h.targetWeight;
    const delta = Math.round((targetValue - h.marketValue) * 100) / 100;
    return {
      symbol: h.symbol,
      action: delta >= 0 ? 'buy' : 'sell',
      amount: Math.abs(delta),
      driftBps: Math.round((h.currentWeight - h.targetWeight) * 10000),
    };
  });
}

/**
 * Execute a portfolio rebalance for a managed account.
 */
async function rebalancePortfolio(data) {
  const startTime = Date.now();
  const rebalanceId = uuidv4();
  const portfolioValue = Math.round(HOLDINGS.reduce((sum, h) => sum + h.marketValue, 0) * 100) / 100;

  logger.info('Executing portfolio rebalance', {
    rebalanceId,
    accountId: data.accountId,
    program: data.program,
    portfolioValue,
    service: 'advisory-rebalance',
    route: '/api/8b5893cb/rebalance',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 140));

    const programData = resolveAdvisoryProgram(data.program);
    const trades = buildRebalanceTrades(portfolioValue);
    const advisoryFee = calculateAdvisoryFee(programData, portfolioValue);

    const duration = Date.now() - startTime;

    incrementMetric('rebalance.success', {
      route: '/api/8b5893cb/rebalance',
      program: data.program,
    });
    recordTiming('rebalance.latency', duration, {
      route: '/api/8b5893cb/rebalance',
    });

    return {
      success: true,
      rebalanceId,
      accountId: data.accountId,
      program: programData.config.name,
      portfolioValue,
      advisoryFee: Math.round(advisoryFee * 100) / 100,
      trades,
      status: 'submitted',
      submittedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('rebalance.failure', {
      route: '/api/8b5893cb/rebalance',
      errorClass: error.name,
      program: data.program,
    });
    recordTiming('rebalance.latency', duration, {
      route: '/api/8b5893cb/rebalance',
      error: 'true',
    });

    logger.error('Portfolio rebalance failed', {
      rebalanceId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      accountId: data.accountId,
      program: data.program,
      service: 'advisory-rebalance',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/8b5893cb/rebalance',
        service: 'advisory-rebalance',
        program: data.program,
      },
      extra: { rebalanceId, accountId: data.accountId, portfolioValue },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/8b5893cb.js \u2014 calculateAdvisoryFee',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'advisory-rebalance',
      verticalLabel: 'T. Rowe Price Portfolio Rebalance',
      customer: '8b5893cb',
      tags: [
        { key: 'route', value: '/api/8b5893cb/rebalance' },
        { key: 'service', value: 'advisory-rebalance' },
        { key: 'program', value: data.program },
      ],
      extra: { rebalanceId, accountId: data.accountId, portfolioValue },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'advisory-rebalance@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from rebalance error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { rebalancePortfolio, HOLDINGS, ADVISORY_PROGRAMS };
