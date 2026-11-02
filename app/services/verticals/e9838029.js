/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.CAPITALONTAP_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-e9838029-accounting-sync';
const ROUTE = '/api/e9838029/accounting-sync';

const LATENCY_SLO = { budgetMs: 3000 };
const LEDGER_FETCH_POLICY = { latencyMs: [450, 550] };

const DESTINATIONS = {
  quickbooks: { label: 'QuickBooks Online', account: 'Capital on Tap Visa ••4417' },
  xero: { label: 'Xero', account: 'Capital on Tap Business Card' },
};

const CARDS = {
  c4417: { cardholder: 'Jonathan Jensen', role: 'Account owner', last4: '4417', type: 'Physical', monthlyLimitCents: 0 },
  c2093: { cardholder: 'Ashley Luna', role: 'Operations', last4: '2093', type: 'Physical', monthlyLimitCents: 1500000 },
  c7361: { cardholder: 'Salvatore Byrd', role: 'Purchasing', last4: '7361', type: 'Physical', monthlyLimitCents: 1000000 },
  c5528: { cardholder: 'Kristopher Mason', role: 'Field sales', last4: '5528', type: 'Physical', monthlyLimitCents: 50000 },
  c9014: { cardholder: 'Eloise Stokes', role: 'Marketing', last4: '9014', type: 'Virtual', monthlyLimitCents: 50000 },
  c3186: { cardholder: 'Claude Turin', role: 'Administrator', last4: '3186', type: 'Physical', monthlyLimitCents: 750000 },
  c6402: { cardholder: 'Priya Raman', role: 'Finance', last4: '6402', type: 'Virtual', monthlyLimitCents: 300000 },
  c1875: { cardholder: 'Marcus Webb', role: 'Warehouse', last4: '1875', type: 'Physical', monthlyLimitCents: 250000 },
  c8249: { cardholder: 'Hannah Ortiz', role: 'Customer success', last4: '8249', type: 'Virtual', monthlyLimitCents: 100000 },
  c4730: { cardholder: 'Devon Clarke', role: 'Engineering', last4: '4730', type: 'Virtual', monthlyLimitCents: 200000 },
  c2561: { cardholder: 'Rosa Delgado', role: 'Front of house', last4: '2561', type: 'Physical', monthlyLimitCents: 80000 },
  c9637: { cardholder: 'Theo Nakamura', role: 'Delivery', last4: '9637', type: 'Physical', monthlyLimitCents: 60000 },
  c3308: { cardholder: 'Grace Whitfield', role: 'Events', last4: '3308', type: 'Virtual', monthlyLimitCents: 120000 },
  c7092: { cardholder: 'Online subscriptions', role: 'Shared virtual card', last4: '7092', type: 'Virtual', monthlyLimitCents: 150000 },
};

const ALL_CARDS = Object.keys(CARDS);

const CARD_SCOPES = {
  all: { label: `All company cards (${ALL_CARDS.length})`, cards: ALL_CARDS },
  ...Object.fromEntries(ALL_CARDS.map((key) => [
    key,
    { label: `${CARDS[key].cardholder} ••${CARDS[key].last4}`, cards: [key] },
  ])),
};

const EXPENSE_CATEGORIES = ['Supplies', 'Inventory', 'Travel', 'Meals', 'Software', 'Fuel', 'Advertising', 'Utilities'];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Capital on Tap accounting sync request:',
  '- Service: `app/services/verticals/e9838029.js`',
  '- Route: `app/routes/verticals/e9838029.js`',
  '- Page: `app/public/verticals/e9838029.html` (served at `/capitalontap`)',
  '- Test: `tests/e9838029-accounting-sync.test.js`',
  '',
  'Accounting syncs with the default "All company cards" scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call via Datadog / Sentry.',
  'The culprit is `syncCardLedgers` in the service.',
  'Find the root cause of the latency and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-card ledger fetch latency.',
  'Preserve the response payload for every scope and destination, including the order of per-card results and the summary totals.',
  'Run `npx jest tests/e9838029-accounting-sync.test.js --runInBand` and `npm run lint`.',
  'Verify the default accounting sync at `/capitalontap` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashLedger(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function fetchCardLedger(business, destinationKey, cardKey) {
  const [min, max] = LEDGER_FETCH_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const card = CARDS[cardKey];
  const hash = hashLedger(`${business.toLowerCase()}:${destinationKey}:${cardKey}`);
  const transactions = 4 + (hash % 23);
  const amountCents = transactions * (1800 + ((hash >>> 5) % 9200));
  const needsReceipt = (hash >>> 11) % 4 === 0 ? 1 + ((hash >>> 13) % 3) : 0;
  const cashBackCents = Math.round(amountCents * 0.015);

  return {
    card: cardKey,
    cardholder: card.cardholder,
    role: card.role,
    last4: card.last4,
    type: card.type,
    transactionsSynced: transactions,
    amountCents,
    cashBackCents,
    needsReceipt,
    topCategory: EXPENSE_CATEGORIES[(hash >>> 7) % EXPENSE_CATEGORIES.length],
    status: needsReceipt > 0 ? 'needs_receipts' : 'synced',
  };
}

/**
 * Pull each card's cleared transactions from the card ledger and post them to the
 * accounting destination. Results are returned in the scope's card order so the
 * reconciliation report lines up with the Cards tab in the app.
 */
async function syncCardLedgers(business, destinationKey, cards) {
  const results = [];
  for (const cardKey of cards) {
    results.push(await fetchCardLedger(business, destinationKey, cardKey));
  }
  return results;
}

function summarize(results) {
  return {
    cardsSynced: results.length,
    transactionsSynced: results.reduce((sum, r) => sum + r.transactionsSynced, 0),
    amountCents: results.reduce((sum, r) => sum + r.amountCents, 0),
    cashBackCents: results.reduce((sum, r) => sum + r.cashBackCents, 0),
    needsReceipt: results.reduce((sum, r) => sum + r.needsReceipt, 0),
    cardsNeedingReceipts: results.filter((r) => r.status === 'needs_receipts').length,
  };
}

function validateSyncRequest(data) {
  const validBusiness = typeof data.business === 'string'
    && data.business.length >= 2
    && data.business.length <= 120;
  const validDestination = Object.hasOwn(DESTINATIONS, data.destination);
  const validScope = Object.hasOwn(CARD_SCOPES, data.scope);

  if (!validBusiness || !validDestination || !validScope) {
    const error = new Error('Enter a business name (2–120 characters), a supported accounting platform and a valid card scope.');
    error.name = 'ValidationError';
    error.code = 'ACCOUNTING_SYNC_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, cardsSynced, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      scope: data.scope,
      destination: data.destination,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      cardsSynced,
      business: data.business,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/e9838029.js — syncCardLedgers',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Capital on Tap Accounting Sync',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'e9838029',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'scope', value: data.scope },
      { key: 'destination', value: data.destination },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      cardsSynced,
      datadogMetric: 'accounting_sync.latency',
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
    logger.error('Failed to create Devin session for Capital on Tap accounting-sync latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function runAccountingSync(data = {}) {
  const startTime = Date.now();
  const syncId = `COT-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    business: requestData.business === undefined || requestData.business === null
      ? 'Surewood Timber Co.'
      : String(requestData.business).trim(),
    destination: String(requestData.destination === undefined ? 'quickbooks' : requestData.destination).trim().toLowerCase(),
    scope: String(requestData.scope === undefined ? 'all' : requestData.scope).trim().toLowerCase(),
  };

  validateSyncRequest(normalized);

  const scope = CARD_SCOPES[normalized.scope];
  const destination = DESTINATIONS[normalized.destination];

  logger.info('Running Capital on Tap accounting sync', {
    syncId,
    business: normalized.business,
    destination: normalized.destination,
    scope: normalized.scope,
    cards: scope.cards.length,
    service: SERVICE,
    route: ROUTE,
  });

  const results = await syncCardLedgers(normalized.business, normalized.destination, scope.cards);
  const summary = summarize(results);
  const durationMs = Date.now() - startTime;

  incrementMetric('accounting_sync.success', {
    route: ROUTE,
    scope: normalized.scope,
    destination: normalized.destination,
  });
  recordTiming('accounting_sync.latency', durationMs, {
    route: ROUTE,
    destination: normalized.destination,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('accounting_sync.latency_budget_breach', {
      route: ROUTE,
      scope: normalized.scope,
      destination: normalized.destination,
    });
    logger.warn('Capital on Tap accounting sync exceeded latency budget', {
      syncId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      cardsSynced: results.length,
      scope: normalized.scope,
      destination: normalized.destination,
      service: SERVICE,
    });
    logger.warn('Capital on Tap accounting sync latency breach — triggering Devin session', {
      syncId,
      service: SERVICE,
      route: ROUTE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: syncId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      cardsSynced: results.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    syncId,
    business: normalized.business,
    destination: {
      key: normalized.destination,
      label: destination.label,
      account: destination.account,
    },
    scope: {
      key: normalized.scope,
      label: scope.label,
    },
    cardsSynced: results.length,
    results,
    summary,
    durationMs,
  };
}

module.exports = {
  runAccountingSync,
  summarize,
  CARDS,
  ALL_CARDS,
  CARD_SCOPES,
  DESTINATIONS,
  LEDGER_FETCH_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
