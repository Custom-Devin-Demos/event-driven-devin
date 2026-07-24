const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Schwab tradable securities catalog. Each instrument maps to the asset class
 * that drives its commission and regulatory-fee treatment at order execution.
 */
const SECURITIES = [
  { symbol: 'SCHB', name: 'Schwab U.S. Broad Market ETF', assetClass: 'etf', lastPrice: 24.18 },
  { symbol: 'AAPL', name: 'Apple Inc.', assetClass: 'equity', lastPrice: 227.52 },
  { symbol: 'SWPPX', name: 'Schwab S&P 500 Index Fund', assetClass: 'mutual_fund', lastPrice: 92.74 },
  { symbol: 'NVDA', name: 'NVIDIA Corporation', assetClass: 'equity', lastPrice: 178.36 },
];

/**
 * Registered fee schedule. Each fee code declares how it is assessed and the
 * rate/basis used to compute the amount owed on an order.
 */
const FEE_SCHEDULE = [
  { code: 'COMM-EQUITY', name: 'Online Equity Commission', basis: 'per_trade', rate: 0.0 },
  { code: 'COMM-OPTION', name: 'Options Contract Fee', basis: 'per_contract', rate: 0.65 },
  { code: 'COMM-MF-NTF', name: 'No-Transaction-Fee Mutual Fund', basis: 'per_trade', rate: 0.0 },
  { code: 'FEE-ADR', name: 'ADR Custody Fee', basis: 'per_share', rate: 0.005 },
];

/**
 * Commission profile per asset class, used to resolve the base commission line
 * before regulatory fees are layered on.
 */
const COMMISSION_PROFILE = {
  equity: { feeCode: 'COMM-EQUITY', label: 'Online Equity' },
  etf: { feeCode: 'COMM-EQUITY', label: 'Online ETF' },
  mutual_fund: { feeCode: 'COMM-MF-NTF', label: 'NTF Mutual Fund' },
};

/**
 * Order-routing venues. Drives the National Best Bid and Offer (NBBO)
 * execution-quality tier reported back to the client.
 */
const ROUTING_VENUES = {
  US: { venue: 'schwab-smart-router', label: 'Schwab Smart Router' },
  'US-EAST': { venue: 'nyse-arca', label: 'NYSE Arca' },
  'US-WEST': { venue: 'nasdaq-bx', label: 'Nasdaq BX' },
};

/**
 * Regulatory fees that are force-assessed on every equity/ETF SELL order.
 * The SEC Section 31 transaction fee must be attached so the sale is reported,
 * but its fee code is not yet registered in the FEE_SCHEDULE catalog.
 */
const MANDATORY_SELL_FEES = [
  { code: 'FEE-SEC-31-2026', reason: 'SEC Section 31 transaction fee (regulatory)' },
  { code: 'FEE-TAF', reason: 'FINRA Trading Activity Fee' },
];

/**
 * Returns the NBBO execution-quality tier for a routing venue.
 */
function getExecutionTier(routing) {
  if (routing === 'schwab-smart-router') return { tier: 'price-improved', label: 'Price improvement eligible' };
  if (routing === 'nyse-arca') return { tier: 'lit', label: 'Lit exchange routing' };
  return { tier: 'standard', label: 'Standard routing' };
}

/**
 * Layers the mandatory regulatory fees onto the requested fee lines for
 * sell-side equity and ETF orders.
 */
function applyRegulatoryFees(feeLines, side, assetClass) {
  const isReportableSell = side === 'sell' && (assetClass === 'equity' || assetClass === 'etf');
  if (!isReportableSell) return feeLines;
  const regulatory = MANDATORY_SELL_FEES.map((fee) => ({ code: fee.code, source: 'regulatory' }));
  return [...feeLines, ...regulatory];
}

/**
 * Resolves the requested trade to its base commission fee line before
 * regulatory fees are applied.
 */
function resolveCommission(assetClass, region) {
  const venueConfig = ROUTING_VENUES[region];
  if (!venueConfig) {
    throw Object.assign(new Error(`Unknown routing region: ${region}`), { code: 'INVALID_REGION' });
  }
  const profile = COMMISSION_PROFILE[assetClass];
  if (!profile) {
    throw Object.assign(new Error(`Unsupported asset class: ${assetClass}`), { code: 'INVALID_ASSET_CLASS' });
  }
  const tier = getExecutionTier(venueConfig.venue);
  return {
    feeLines: [{ code: profile.feeCode, source: 'commission' }],
    venue: venueConfig.venue,
    executionTier: tier.tier,
    executionLabel: tier.label,
  };
}

/**
 * Builds the settlement summary returned to the caller — one line per assessed
 * fee, resolving each fee code to its schedule definition and rate.
 * BUG: FEE-SEC-31-2026 is not in FEE_SCHEDULE, so feeDef.rate crashes.
 */
function buildSettlementSummary(feeLines, quantity) {
  return feeLines.map((line) => {
    const feeDef = FEE_SCHEDULE.find((f) => f.code === line.code);
    const amount = feeDef.basis === 'per_share'
      ? feeDef.rate * quantity
      : feeDef.rate;
    return {
      code: line.code,
      name: feeDef.name,
      basis: feeDef.basis,
      rate: feeDef.rate,
      source: line.source,
      amount: Number(amount.toFixed(2)),
    };
  });
}

/**
 * Executes a Schwab brokerage trade order.
 */
async function executeOrder(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Executing Schwab trade order', {
    orderId,
    accountId: orderData.accountId,
    symbol: orderData.symbol,
    side: orderData.side,
    quantity: orderData.quantity,
    service: 'schwab-trading',
    route: '/api/ef58967c/order',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const security = SECURITIES.find((s) => s.symbol === orderData.symbol) || SECURITIES[0];
    const quantity = Number(orderData.quantity) || 0;
    const notional = Number((security.lastPrice * quantity).toFixed(2));

    const commission = resolveCommission(security.assetClass, orderData.region);
    const feeLines = applyRegulatoryFees(commission.feeLines, orderData.side, security.assetClass);
    const settlement = buildSettlementSummary(feeLines, quantity);

    const totalFees = Number(settlement.reduce((sum, line) => sum + line.amount, 0).toFixed(2));
    const duration = Date.now() - startTime;

    incrementMetric('order.success', {
      route: '/api/ef58967c/order',
      source: 'schwab-trading',
    });
    recordTiming('order.latency', duration, {
      route: '/api/ef58967c/order',
    });

    return {
      success: true,
      orderId,
      symbol: security.symbol,
      side: orderData.side,
      quantity,
      notional,
      venue: commission.venue,
      executionTier: commission.executionTier,
      totalFees,
      settlement,
      status: 'filled',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('order.failure', {
      route: '/api/ef58967c/order',
      errorClass: error.name,
      source: 'schwab-trading',
    });
    recordTiming('order.latency', duration, {
      route: '/api/ef58967c/order',
      error: 'true',
    });

    logger.error('Schwab trade order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      accountId: orderData.accountId,
      symbol: orderData.symbol,
      service: 'schwab-trading',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/ef58967c/order',
        service: 'schwab-trading',
        source: 'schwab-trading',
      },
      extra: {
        orderId,
        accountId: orderData.accountId,
        symbol: orderData.symbol,
        side: orderData.side,
        region: orderData.region,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ef58967c.js \u2014 buildSettlementSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'ef58967c',
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'schwab-trading',
      verticalLabel: 'Charles Schwab \u2014 Trade Order Execution',
      tags: [
        { key: 'route', value: '/api/ef58967c/order' },
        { key: 'service', value: 'schwab-trading' },
        { key: 'category', value: 'order-execution' },
        { key: 'data_class', value: 'financial' },
      ],
      extra: { orderId, accountId: orderData.accountId, symbol: orderData.symbol, side: orderData.side },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'schwab-trading@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Schwab order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  executeOrder,
  buildSettlementSummary,
  applyRegulatoryFees,
  resolveCommission,
  SECURITIES,
  FEE_SCHEDULE,
  ROUTING_VENUES,
};
