const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Morgan Stanley security master — instruments eligible for advisory rebalancing
 */
const SECURITY_MASTER = [
  { id: 'VTI', name: 'Vanguard Total Stock Market ETF', assetClass: 'us-equity', price: 289.41 },
  { id: 'VEA', name: 'Vanguard FTSE Developed Markets ETF', assetClass: 'intl-equity', price: 54.18 },
  { id: 'AGG', name: 'iShares Core U.S. Aggregate Bond ETF', assetClass: 'fixed-income', price: 98.72 },
  { id: 'MUB', name: 'iShares National Muni Bond ETF', assetClass: 'municipal', price: 106.35 },
  { id: 'MSIQX', name: 'Morgan Stanley Institutional Growth Portfolio', assetClass: 'us-equity', price: 62.80 },
  { id: 'MSGDX', name: 'Morgan Stanley Global Fixed Income Portfolio', assetClass: 'fixed-income', price: 41.55 },
  { id: 'AAPL', name: 'Apple Inc.', assetClass: 'us-equity', price: 231.60 },
  { id: 'BRKB', name: 'Berkshire Hathaway Inc. Class B', assetClass: 'us-equity', price: 478.20 },
];

/**
 * Advisory program fee schedules
 */
const ADVISORY_PROGRAMS = {
  SELECT_UMA: { feeRate: 0.0125, label: 'Select UMA', currency: 'USD' },
  CONSULTING_GROUP: { feeRate: 0.0100, label: 'Consulting Group Advisor', currency: 'USD' },
  PORTFOLIO_MGMT: { feeRate: 0.0150, label: 'Portfolio Management', currency: 'USD' },
  ACCESS_INVESTING: { feeRate: 0.0030, label: 'Access Investing', currency: 'USD' },
};

/**
 * Mandatory allocations appended to every rebalance basket —
 * the liquidity sleeve required by the investment policy statement.
 */
const MANDATORY_ALLOCATIONS = [
  { symbol: 'MS-CASH-SWEEP-2026', notional: 0, qty: 1, side: 'buy' },
];

/**
 * Looks up the household breakpoint discount for a given notional.
 */
function getBreakpointDiscount(notional) {
  if (notional >= 1000000) return { rate: 0.20, label: '20% breakpoint — households $1M+' };
  if (notional >= 250000) return { rate: 0.10, label: '10% breakpoint — households $250K+' };
  return { rate: 0, label: 'None' };
}

/**
 * Merges the policy-mandated allocations into the rebalance basket.
 */
function applyMandatoryAllocations(trades) {
  return [...trades, ...MANDATORY_ALLOCATIONS];
}

/**
 * Computes advisory fees and the net cash impact of the rebalance.
 */
function computeAdvisoryFees(notional, programCode) {
  const program = ADVISORY_PROGRAMS[programCode];
  if (!program) {
    throw Object.assign(new Error(`Unknown advisory program: ${programCode}`), { code: 'INVALID_PROGRAM' });
  }
  const grossFee = notional * program.feeRate;
  const breakpoint = getBreakpointDiscount(notional);
  const discountAmount = grossFee * breakpoint.rate;
  return {
    notional,
    grossFee: Math.round(grossFee * 100) / 100,
    discount: Math.round(discountAmount * 100) / 100,
    discountLabel: breakpoint.label,
    netFee: Math.round((grossFee - discountAmount) * 100) / 100,
    programLabel: program.label,
    currency: program.currency,
  };
}

/**
 * Formats the trade confirmation shown to the client.
 * BUG: MS-CASH-SWEEP-2026 is not in SECURITY_MASTER, so security.name crashes.
 */
function formatTradeConfirmation(allTrades) {
  return allTrades.map((trade) => {
    const security = SECURITY_MASTER.find((s) => s.id === trade.symbol);
    return {
      symbol: trade.symbol,
      name: security.name,
      assetClass: security.assetClass,
      side: trade.side,
      qty: trade.qty,
      notional: trade.notional,
    };
  });
}

/**
 * Submits a Morgan Stanley advisory account rebalance.
 */
async function submitRebalance(orderData) {
  const startTime = Date.now();
  const rebalanceId = uuidv4();

  logger.info('Processing Morgan Stanley rebalance', {
    rebalanceId,
    accountId: orderData.accountId,
    notional: orderData.notional,
    service: 'ms-wealth-management',
    route: '/api/c7d11cb8/rebalance',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allTrades = applyMandatoryAllocations(orderData.trades);

    const computedNotional = allTrades.reduce(
      (sum, trade) => sum + trade.notional,
      0,
    ) || orderData.notional;

    const fees = computeAdvisoryFees(computedNotional, orderData.programCode);
    const confirmation = formatTradeConfirmation(allTrades);

    const duration = Date.now() - startTime;

    incrementMetric('rebalance.success', {
      route: '/api/c7d11cb8/rebalance',
      source: 'ms-online',
    });
    recordTiming('rebalance.latency', duration, {
      route: '/api/c7d11cb8/rebalance',
    });

    return {
      success: true,
      rebalanceId,
      notional: fees.notional,
      grossFee: fees.grossFee,
      discount: fees.discount,
      discountLabel: fees.discountLabel,
      netFee: fees.netFee,
      programLabel: fees.programLabel,
      confirmation,
      status: 'submitted',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('rebalance.failure', {
      route: '/api/c7d11cb8/rebalance',
      errorClass: error.name,
      source: 'ms-online',
    });
    recordTiming('rebalance.latency', duration, {
      route: '/api/c7d11cb8/rebalance',
      error: 'true',
    });

    logger.error('Morgan Stanley rebalance failed', {
      rebalanceId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      accountId: orderData.accountId,
      service: 'ms-wealth-management',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/c7d11cb8/rebalance',
        service: 'ms-wealth-management',
        source: 'ms-online',
      },
      extra: {
        rebalanceId,
        accountId: orderData.accountId,
        notional: orderData.notional,
        programCode: orderData.programCode,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/c7d11cb8.js \u2014 formatTradeConfirmation',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'ms-wealth-management',
      verticalLabel: 'Morgan Stanley Wealth Management',
      tags: [
        { key: 'route', value: '/api/c7d11cb8/rebalance' },
        { key: 'service', value: 'ms-wealth-management' },
      ],
      extra: { rebalanceId, accountId: orderData.accountId, notional: orderData.notional },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'ms-wealth-management@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Morgan Stanley rebalance error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  submitRebalance,
  computeAdvisoryFees,
  formatTradeConfirmation,
  applyMandatoryAllocations,
  SECURITY_MASTER,
  ADVISORY_PROGRAMS,
};
