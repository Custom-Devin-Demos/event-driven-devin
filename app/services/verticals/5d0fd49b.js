/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.OPENSEA_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-5d0fd49b-sweep-quote';
const ROUTE = '/api/5d0fd49b/sweep-quote';

const LATENCY_SLO = { budgetMs: 3000 };
const MARKETPLACE_QUOTE_POLICY = { latencyMs: [450, 550] };
const ETH_USD = 2284.33;
const LISTINGS_PER_MARKETPLACE = 10;
const MAX_SWEEP_QUANTITY = 10;

const COLLECTIONS = {
  boredapeyachtclub: { label: 'Bored Ape Yacht Club', chain: 'Ethereum', floorEth: 5.65, supply: 9998 },
  argonauts: { label: 'Argonauts', chain: 'Ethereum', floorEth: 0.5512, supply: 5000 },
  'yield-field-deeds': { label: 'Yield Field Deeds', chain: 'Base', floorEth: 0.7548, supply: 3333 },
  'crawlers-by-slava-rybin': { label: 'Crawlers by Slava Rybin', chain: 'Ethereum', floorEth: 0.1499, supply: 1000 },
  'spooky-rh': { label: 'Spooky RH', chain: 'Base', floorEth: 0.1503, supply: 2222 },
};

const MARKETPLACES = {
  opensea: { label: 'OpenSea', feePct: 1 },
  blur: { label: 'Blur', feePct: 0.5 },
  magiceden: { label: 'Magic Eden', feePct: 2 },
  looksrare: { label: 'LooksRare', feePct: 0.5 },
  x2y2: { label: 'X2Y2', feePct: 0.5 },
  rarible: { label: 'Rarible', feePct: 1 },
  element: { label: 'Element', feePct: 0.5 },
  okx: { label: 'OKX NFT', feePct: 0.5 },
  sudoswap: { label: 'Sudoswap', feePct: 0.5 },
  nftx: { label: 'NFTX', feePct: 1 },
  zora: { label: 'Zora', feePct: 1 },
  foundation: { label: 'Foundation', feePct: 5 },
  coinbase: { label: 'Coinbase NFT', feePct: 1 },
  mintify: { label: 'Mintify', feePct: 0.5 },
};

const ALL_MARKETPLACES = Object.keys(MARKETPLACES);

const SWEEP_SOURCES = {
  all: { label: `All marketplaces (${ALL_MARKETPLACES.length}) · best price`, marketplaces: ALL_MARKETPLACES },
  opensea: { label: 'OpenSea listings only', marketplaces: ['opensea'] },
  blur: { label: 'Blur listings only', marketplaces: ['blur'] },
  magiceden: { label: 'Magic Eden listings only', marketplaces: ['magiceden'] },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the OpenSea Sweep the floor quote request:',
  '- Service: `app/services/verticals/5d0fd49b.js`',
  '- Route: `app/routes/verticals/5d0fd49b.js`',
  '- Page: `app/public/verticals/5d0fd49b.html` (served at `/opensea`)',
  '- Test: `tests/5d0fd49b-sweep-quote.test.js`',
  '',
  'The default "All marketplaces" sweep quote succeeds but takes ~7s versus the 3000ms latency budget.',
  'The culprit is `aggregateMarketplaceListings` in the service.',
  'Fix the latency without raising or removing the latency budget, the breach alert, or the simulated per-marketplace listing latency.',
  'Preserve the response payload, marketplace quote order, cheapest-first sweep selection, and summary totals.',
  'Run `npx jest tests/5d0fd49b-sweep-quote.test.js --runInBand` and `npm run lint`.',
  'Verify the default sweep quote at `/opensea` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashListing(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function roundEth(value) {
  return Math.round(value * 10000) / 10000;
}

async function fetchMarketplaceListings(collectionKey, marketplaceKey) {
  const [min, max] = MARKETPLACE_QUOTE_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const collection = COLLECTIONS[collectionKey];
  const listings = [];
  for (let i = 0; i < LISTINGS_PER_MARKETPLACE; i += 1) {
    const hash = hashListing(`${collectionKey}:${marketplaceKey}:${i}`);
    const premium = 0.002 * i + (hash % 40) / 1000;
    listings.push({
      tokenId: String(hash % collection.supply),
      marketplace: marketplaceKey,
      marketplaceLabel: MARKETPLACES[marketplaceKey].label,
      priceEth: roundEth(collection.floorEth * (1 + premium)),
    });
  }

  return {
    marketplace: marketplaceKey,
    label: MARKETPLACES[marketplaceKey].label,
    feePct: MARKETPLACES[marketplaceKey].feePct,
    listingCount: listings.length,
    bestPriceEth: Math.min(...listings.map((listing) => listing.priceEth)),
    listings,
  };
}

/**
 * Marketplace quotes are returned in aggregator priority order so the source breakdown matches the sweep panel.
 */
async function aggregateMarketplaceListings(collectionKey, marketplaces) {
  const quotes = [];
  for (const marketplaceKey of marketplaces) {
    quotes.push(await fetchMarketplaceListings(collectionKey, marketplaceKey));
  }
  return quotes;
}

function selectSweep(quotes, quantity) {
  const pool = quotes.flatMap((quote) => quote.listings.map((listing) => ({ ...listing, feePct: quote.feePct })));
  return pool
    .map((listing, index) => ({ listing, index }))
    .sort((a, b) => (a.listing.priceEth - b.listing.priceEth) || (a.index - b.index))
    .slice(0, quantity)
    .map(({ listing }) => listing);
}

function validationError(message, requestId) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.statusCode = 400;
  error.code = 'INVALID_SWEEP_REQUEST';
  error.requestId = requestId;
  return error;
}

function validateSweepRequest(data, requestId) {
  if (!Object.hasOwn(COLLECTIONS, data.collection)) {
    throw validationError('Choose a supported collection to sweep.', requestId);
  }
  if (!Number.isInteger(data.quantity) || data.quantity < 1 || data.quantity > MAX_SWEEP_QUANTITY) {
    throw validationError(`Sweep between 1 and ${MAX_SWEEP_QUANTITY} items.`, requestId);
  }
  if (!Object.hasOwn(SWEEP_SOURCES, data.source)) {
    throw validationError('Choose a valid listing source.', requestId);
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, marketplacesQueried, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      collection: data.collection,
      source: data.source,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      marketplacesQueried,
      quantity: data.quantity,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/5d0fd49b.js — aggregateMarketplaceListings',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'OpenSea Sweep the Floor',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '5d0fd49b',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'collection', value: data.collection },
      { key: 'source', value: data.source },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      marketplacesQueried,
      datadogMetric: 'sweep_quote.latency',
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
    logger.error('Failed to create Devin session for OpenSea sweep-quote latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function quoteSweep({
  collection = 'boredapeyachtclub',
  quantity = 5,
  source = 'all',
  devinUserId,
  devinOrgId,
  devinEmail,
} = {}) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const normalized = {
    collection: typeof collection === 'string' ? collection.trim().toLowerCase() : collection,
    quantity,
    source: typeof source === 'string' ? source.trim().toLowerCase() : source,
    devinUserId,
    devinOrgId,
    devinEmail,
  };

  validateSweepRequest(normalized, requestId);

  const selectedCollection = COLLECTIONS[normalized.collection];
  const selectedSource = SWEEP_SOURCES[normalized.source];

  logger.info('Quoting OpenSea floor sweep', {
    requestId,
    collection: normalized.collection,
    quantity: normalized.quantity,
    source: normalized.source,
    service: SERVICE,
    route: ROUTE,
  });

  const quotes = await aggregateMarketplaceListings(normalized.collection, selectedSource.marketplaces);
  const sweep = selectSweep(quotes, normalized.quantity);
  const subtotalEth = roundEth(sweep.reduce((sum, item) => sum + item.priceEth, 0));
  const marketplaceFeesEth = roundEth(sweep.reduce((sum, item) => sum + (item.priceEth * item.feePct) / 100, 0));
  const gasEth = roundEth(0.0021 + 0.0009 * sweep.length);
  const totalEth = roundEth(subtotalEth + marketplaceFeesEth + gasEth);
  const latencyMs = Date.now() - startTime;

  incrementMetric('sweep_quote.success', {
    route: ROUTE,
    collection: normalized.collection,
    source: normalized.source,
  });
  recordTiming('sweep_quote.latency', latencyMs, {
    route: ROUTE,
    source: normalized.source,
  });

  if (latencyMs > LATENCY_SLO.budgetMs) {
    incrementMetric('sweep_quote.latency_budget_breach', {
      route: ROUTE,
      collection: normalized.collection,
      source: normalized.source,
    });
    logger.warn('OpenSea sweep quote exceeded latency budget', {
      requestId,
      latencyMs,
      budgetMs: LATENCY_SLO.budgetMs,
      marketplacesQueried: quotes.length,
      collection: normalized.collection,
      source: normalized.source,
      service: SERVICE,
    });
    logger.warn('OpenSea sweep-quote latency breach — triggering Devin session', {
      requestId,
      service: SERVICE,
      route: ROUTE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs: latencyMs,
      budgetMs: LATENCY_SLO.budgetMs,
      marketplacesQueried: quotes.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    requestId,
    collection: {
      key: normalized.collection,
      label: selectedCollection.label,
      chain: selectedCollection.chain,
      floorEth: selectedCollection.floorEth,
    },
    source: normalized.source,
    sourceLabel: selectedSource.label,
    quantity: normalized.quantity,
    marketplacesQueried: quotes.length,
    listingsScanned: quotes.reduce((sum, quote) => sum + quote.listingCount, 0),
    marketplaceQuotes: quotes.map((quote) => ({
      marketplace: quote.marketplace,
      label: quote.label,
      listingCount: quote.listingCount,
      bestPriceEth: quote.bestPriceEth,
    })),
    sweep: sweep.map(({ feePct, ...item }) => ({ ...item, feeEth: roundEth((item.priceEth * feePct) / 100) })),
    summary: {
      itemsFilled: sweep.length,
      subtotalEth,
      marketplaceFeesEth,
      gasEth,
      totalEth,
      totalUsd: Math.round(totalEth * ETH_USD * 100) / 100,
      avgPriceEth: roundEth(subtotalEth / sweep.length),
    },
    ethUsd: ETH_USD,
    latencyMs,
    latencyBudgetMs: LATENCY_SLO.budgetMs,
  };
}

module.exports = {
  quoteSweep,
  aggregateMarketplaceListings,
  selectSweep,
  COLLECTIONS,
  MARKETPLACES,
  SWEEP_SOURCES,
  LATENCY_SLO,
  MARKETPLACE_QUOTE_POLICY,
  ETH_USD,
  MAX_SWEEP_QUANTITY,
};
