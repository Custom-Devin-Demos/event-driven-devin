/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.EQUILEND_SLACK_MEMBER_ID || 'U08S7AVJ478';

const SERVICE = 'customer-f3e617ec-availability-check';
const ROUTE = '/api/f3e617ec/availability-check';

const LATENCY_SLO = { budgetMs: 3000 };
const LENDER_FEED_POLICY = { latencyMs: [450, 550] };

const SECURITIES = {
  AAPL: { label: 'Apple Inc.', isin: 'US0378331005', market: 'US Equities', baseFeeBps: 25, supply: 9 },
  NVDA: { label: 'NVIDIA Corp.', isin: 'US67066G1040', market: 'US Equities', baseFeeBps: 30, supply: 8 },
  TSLA: { label: 'Tesla, Inc.', isin: 'US88160R1014', market: 'US Equities', baseFeeBps: 45, supply: 6 },
  SPY: { label: 'SPDR S&P 500 ETF Trust', isin: 'US78462F1030', market: 'US ETFs', baseFeeBps: 35, supply: 7 },
  GME: { label: 'GameStop Corp.', isin: 'US36467W1099', market: 'US Equities', baseFeeBps: 850, supply: 2 },
  BYND: { label: 'Beyond Meat, Inc.', isin: 'US08862E1091', market: 'US Equities', baseFeeBps: 2400, supply: 1 },
};

const AGENT_LENDER_NETWORK = [
  'Northbridge Custody',
  'Harbor Point Securities Lending',
  'Atlas Trust Agency',
  'Meridian Global Custody',
  'Crestline Asset Servicing',
  'Bluewater Agency Lending',
  'Summit Pension Lending',
  'Ironwood Trust',
  'Keystone Custody Services',
  'Lakeshore Sovereign Fund',
  'Granite Agency Lending',
  'Pacific Rim Custody',
  'Evergreen Insurance Lending',
  'Equilend Internal Inventory',
];

const LENDER_SCOPES = {
  consolidated: { label: 'All connected agent lenders (consolidated)', lenders: AGENT_LENDER_NETWORK },
  preferred: { label: 'Preferred lender — Northbridge Custody', lenders: ['Northbridge Custody'] },
  internal: { label: 'Internal inventory only', lenders: ['Equilend Internal Inventory'] },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the EquiLend Availability locate check:',
  '- Service: `app/services/verticals/f3e617ec.js`',
  '- Route: `app/routes/verticals/f3e617ec.js`',
  '- Page: `app/public/verticals/f3e617ec.html` (served at `/equilend`)',
  '- Test: `tests/f3e617ec-availability-check.test.js`',
  '',
  'Availability checks with the default consolidated lender scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency in `collectLenderAvailability` and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-lender feed latency.',
  'Preserve the response payload for every lender scope, including lender order and the best-fee tie-break.',
  'Run `npx jest tests/f3e617ec-availability-check.test.js --runInBand` and `npm run lint`.',
  'Verify the default availability check at `/equilend` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashFeed(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function queryLenderAvailability(ticker, lender) {
  const [min, max] = LENDER_FEED_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const security = SECURITIES[ticker];
  const hash = hashFeed(`${ticker}:${lender}`);
  const lendableShares = ((hash % 40) + 5) * security.supply * 25000;
  const feeBps = security.baseFeeBps + ((hash >>> 7) % 9) * Math.max(1, Math.round(security.baseFeeBps / 20));

  return {
    lender,
    lendableShares,
    feeBps,
    rebateEligible: security.baseFeeBps < 100,
  };
}

/**
 * Poll each lender's availability feed in network priority order;
 * selectBestAvailability breaks fee ties by that order.
 */
async function collectLenderAvailability(ticker, lenders) {
  const feeds = [];
  for (const lender of lenders) {
    feeds.push(await queryLenderAvailability(ticker, lender));
  }
  return feeds;
}

function selectBestAvailability(feeds) {
  const best = feeds.reduce((current, feed) => {
    if (feed.lendableShares <= 0) return current;
    if (!current || feed.feeBps < current.feeBps) return feed;
    return current;
  }, null);

  return {
    bestLender: best ? best.lender : null,
    bestFeeBps: best ? best.feeBps : null,
    totalLendableShares: feeds.reduce((sum, feed) => sum + feed.lendableShares, 0),
  };
}

function validateAvailabilityRequest(data) {
  const validTicker = Object.hasOwn(SECURITIES, data.ticker);
  const validQuantity = Number.isInteger(data.quantity) && data.quantity >= 100 && data.quantity <= 50000000;
  const validScope = Object.hasOwn(LENDER_SCOPES, data.scope);

  if (!validTicker || !validQuantity || !validScope) {
    const error = new Error('Enter a supported security, a quantity between 100 and 50,000,000 shares, and a lender scope.');
    error.name = 'ValidationError';
    error.code = 'LOCATE_REQUEST_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, lendersPolled, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      ticker: data.ticker,
      scope: data.scope,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      lendersPolled,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/f3e617ec.js — collectLenderAvailability',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'EquiLend Availability Check',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'f3e617ec',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'ticker', value: data.ticker },
      { key: 'scope', value: data.scope },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      lendersPolled,
    },
    level: 'warning',
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
    logger.error('Failed to create Devin session for EquiLend availability-check latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function checkAvailability(data = {}) {
  const startTime = Date.now();
  const locateId = `EQL-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    ticker: String(requestData.ticker || 'AAPL').trim().toUpperCase(),
    quantity: Number(requestData.quantity === undefined ? 250000 : requestData.quantity),
    scope: String(requestData.scope || 'consolidated').trim().toLowerCase(),
  };

  validateAvailabilityRequest(normalized);

  const security = SECURITIES[normalized.ticker];
  const scope = LENDER_SCOPES[normalized.scope];

  logger.info('Checking EquiLend lendable availability', {
    locateId,
    ticker: normalized.ticker,
    quantity: normalized.quantity,
    scope: normalized.scope,
    service: SERVICE,
    route: ROUTE,
  });

  const lenderFeeds = await collectLenderAvailability(normalized.ticker, scope.lenders);
  const best = selectBestAvailability(lenderFeeds);
  const locatedShares = Math.min(normalized.quantity, best.totalLendableShares);
  const status = locatedShares >= normalized.quantity ? 'LOCATED' : 'PARTIAL';
  const durationMs = Date.now() - startTime;

  incrementMetric('availability_check.success', {
    route: ROUTE,
    ticker: normalized.ticker,
    scope: normalized.scope,
  });
  recordTiming('availability_check.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('availability_check.latency_budget_breach', {
      route: ROUTE,
      ticker: normalized.ticker,
      scope: normalized.scope,
    });
    logger.warn('EquiLend availability check exceeded latency budget — triggering Devin', {
      locateId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      lendersPolled: lenderFeeds.length,
      ticker: normalized.ticker,
      scope: normalized.scope,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: locateId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      lendersPolled: lenderFeeds.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    locateId,
    security: {
      ticker: normalized.ticker,
      label: security.label,
      isin: security.isin,
      market: security.market,
    },
    quantity: normalized.quantity,
    scope: {
      key: normalized.scope,
      label: scope.label,
    },
    status,
    locatedShares,
    totalLendableShares: best.totalLendableShares,
    bestLender: best.bestLender,
    bestFeeBps: best.bestFeeBps,
    lendersPolled: lenderFeeds.length,
    lenderFeeds,
    durationMs,
  };
}

module.exports = {
  checkAvailability,
  selectBestAvailability,
  SECURITIES,
  LENDER_SCOPES,
  AGENT_LENDER_NETWORK,
  LENDER_FEED_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
