/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.IBKR_SLACK_MEMBER_ID || 'U08S7AVJ478';

const SERVICE = 'customer-d708940c-order-preview';
const ROUTE = '/api/d708940c/order-preview';

const LATENCY_SLO = { budgetMs: 3000 };
const VENUE_QUOTE_POLICY = { latencyMs: [480, 640] };

const SYMBOLS = {
  AAPL: { label: 'Apple Inc.', exchange: 'NASDAQ', basePrice: 227.52 },
  NVDA: { label: 'NVIDIA Corp.', exchange: 'NASDAQ', basePrice: 178.19 },
  MSFT: { label: 'Microsoft Corp.', exchange: 'NASDAQ', basePrice: 511.46 },
  TSLA: { label: 'Tesla, Inc.', exchange: 'NASDAQ', basePrice: 440.40 },
  SPY: { label: 'SPDR S&P 500 ETF', exchange: 'ARCA', basePrice: 663.70 },
  IBKR: { label: 'Interactive Brokers Group', exchange: 'NASDAQ', basePrice: 66.08 },
};

const SMART_VENUES = [
  'NASDAQ',
  'NYSE',
  'ARCA',
  'BATS',
  'BYX',
  'EDGX',
  'EDGEA',
  'IEX',
  'MEMX',
  'PEARL',
  'LTSE',
  'BEX',
  'PSX',
  'CHX',
  'NYSENAT',
  'IBKRATS',
];

const ROUTING_OPTIONS = {
  smart: { label: 'SMART (Best Execution)', pricing: 'pro', venues: SMART_VENUES },
  nasdaq: { label: 'Directed — NASDAQ', pricing: 'pro', venues: ['NASDAQ'] },
  nyse: { label: 'Directed — NYSE', pricing: 'pro', venues: ['NYSE'] },
  lite: { label: 'IBKR Lite (commission-free)', pricing: 'lite', venues: ['IBKRATS'] },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Interactive Brokers order preview request:',
  '- Service: `app/services/verticals/d708940c.js`',
  '- Route: `app/routes/verticals/d708940c.js`',
  '- Page: `app/public/verticals/d708940c.html` (served at `/ibkr`)',
  '',
  'Order previews with the default SMART routing succeed but take ~9s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated venue latency.',
  'Preserve the response payload for every routing option, including venue order and the best-execution tie-break.',
  'Run `npx jest tests/d708940c-order-preview.test.js --runInBand` and `npm run lint`.',
  'Verify the default order preview at `/ibkr` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function roundToCents(value) {
  return Math.round(value * 100) / 100;
}

function hashVenueQuote(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function quoteVenue(symbol, venue) {
  const [min, max] = VENUE_QUOTE_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const hash = hashVenueQuote(`${symbol}:${venue}`);
  const basePrice = SYMBOLS[symbol].basePrice;
  const bid = roundToCents(basePrice - (hash % 3) / 100);
  const ask = roundToCents(basePrice + 0.01 + ((hash >>> 3) % 3) / 100);

  return {
    venue,
    bid,
    ask,
    bidSize: ((hash >>> 6) % 20 + 1) * 100,
    askSize: ((hash >>> 11) % 20 + 1) * 100,
  };
}

/**
 * Poll venues in SMART priority order; selectBestExecution breaks price ties
 * by that order.
 */
async function collectVenueQuotes(symbol, venues) {
  const quotes = [];
  for (const venue of venues) {
    quotes.push(await quoteVenue(symbol, venue));
  }
  return quotes;
}

function selectBestExecution(side, quotes) {
  const bestQuote = quotes.reduce((best, quote) => {
    if (!best) return quote;
    if (side === 'BUY' && quote.ask < best.ask) return quote;
    if (side === 'SELL' && quote.bid > best.bid) return quote;
    return best;
  }, null);

  return {
    bestVenue: bestQuote.venue,
    nbbo: {
      bid: Math.max(...quotes.map((quote) => quote.bid)),
      ask: Math.min(...quotes.map((quote) => quote.ask)),
    },
  };
}

function validateOrderRequest(data) {
  const validSymbol = Object.hasOwn(SYMBOLS, data.symbol);
  const validSide = data.side === 'BUY' || data.side === 'SELL';
  const validQuantity = Number.isInteger(data.quantity) && data.quantity >= 1 && data.quantity <= 10000;
  const validOrderType = data.orderType === 'MKT' || data.orderType === 'LMT';
  const validLimitPrice = data.orderType !== 'LMT'
    || (Number.isFinite(data.limitPrice) && data.limitPrice > 0);
  const validRouting = Object.hasOwn(ROUTING_OPTIONS, data.routing);

  if (!validSymbol || !validSide || !validQuantity || !validOrderType || !validLimitPrice || !validRouting) {
    const error = new Error('Enter valid order details.');
    error.name = 'ValidationError';
    error.code = 'ORDER_DETAILS_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, venuesPolled, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      symbol: data.symbol,
      routing: data.routing,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      venuesPolled,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/d708940c.js — collectVenueQuotes',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Interactive Brokers Order Preview',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'd708940c',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'symbol', value: data.symbol },
      { key: 'routing', value: data.routing },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      venuesPolled,
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
    logger.error('Failed to create Devin session for Interactive Brokers order-preview latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function previewOrder(data = {}) {
  const startTime = Date.now();
  const previewId = `IBKR-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const limitPrice = requestData.limitPrice === undefined || requestData.limitPrice === null
    || requestData.limitPrice === ''
    ? null
    : Number(requestData.limitPrice);
  const normalized = {
    ...requestData,
    symbol: String(requestData.symbol || 'AAPL').trim().toUpperCase(),
    side: String(requestData.side || 'BUY').trim().toUpperCase(),
    quantity: Number(requestData.quantity === undefined ? 100 : requestData.quantity),
    orderType: String(requestData.orderType || 'MKT').trim().toUpperCase(),
    limitPrice,
    routing: String(requestData.routing || 'smart').trim().toLowerCase(),
  };

  validateOrderRequest(normalized);

  const symbol = SYMBOLS[normalized.symbol];
  const routing = ROUTING_OPTIONS[normalized.routing];

  logger.info('Previewing Interactive Brokers order', {
    previewId,
    symbol: normalized.symbol,
    side: normalized.side,
    quantity: normalized.quantity,
    orderType: normalized.orderType,
    routing: normalized.routing,
    service: SERVICE,
    route: ROUTE,
  });

  const venueQuotes = await collectVenueQuotes(normalized.symbol, routing.venues);
  const bestExecution = selectBestExecution(normalized.side, venueQuotes);
  const estimatedPrice = normalized.orderType === 'LMT'
    ? normalized.limitPrice
    : (normalized.side === 'BUY' ? bestExecution.nbbo.ask : bestExecution.nbbo.bid);
  const commissionUsd = routing.pricing === 'lite'
    ? 0
    : roundToCents(Math.max(1, Math.min(0.005 * normalized.quantity, 0.01 * normalized.quantity * estimatedPrice)));
  const estimatedTotalUsd = roundToCents(
    normalized.quantity * estimatedPrice
    + (normalized.side === 'BUY' ? commissionUsd : -commissionUsd),
  );
  const durationMs = Date.now() - startTime;

  incrementMetric('order_preview.success', {
    route: ROUTE,
    symbol: normalized.symbol,
    routing: normalized.routing,
  });
  recordTiming('order_preview.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('order_preview.latency_budget_breach', {
      route: ROUTE,
      symbol: normalized.symbol,
      routing: normalized.routing,
    });
    logger.warn('Interactive Brokers order preview exceeded latency budget', {
      previewId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      venuesPolled: venueQuotes.length,
      symbol: normalized.symbol,
      routing: normalized.routing,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: previewId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      venuesPolled: venueQuotes.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    previewId,
    symbol: {
      key: normalized.symbol,
      label: symbol.label,
      exchange: symbol.exchange,
    },
    side: normalized.side,
    quantity: normalized.quantity,
    orderType: normalized.orderType,
    limitPrice: normalized.orderType === 'LMT' ? normalized.limitPrice : null,
    routing: {
      key: normalized.routing,
      label: routing.label,
    },
    bestVenue: bestExecution.bestVenue,
    nbbo: bestExecution.nbbo,
    estimatedPrice,
    commissionUsd,
    estimatedTotalUsd,
    venuesPolled: venueQuotes.length,
    venueQuotes,
    currency: 'USD',
    durationMs,
  };
}

module.exports = {
  previewOrder,
  selectBestExecution,
  SYMBOLS,
  ROUTING_OPTIONS,
  SMART_VENUES,
  VENUE_QUOTE_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
