/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.CAPITOLIS_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-a6fe3aeb-compression-preview';
const ROUTE = '/api/a6fe3aeb/compression-preview';

const LATENCY_SLO = { budgetMs: 3000 };
const PORTFOLIO_FEED_POLICY = { latencyMs: [450, 550] };

const COUNTERPARTIES = {
  atlantic: { label: 'Atlantic Union Bank', region: 'NA', scale: 1.35 },
  hudson: { label: 'Hudson Capital Markets', region: 'NA', scale: 1.2 },
  lakeshore: { label: 'Lakeshore Securities', region: 'NA', scale: 0.85 },
  pacificrim: { label: 'Pacific Rim Bancorp', region: 'NA', scale: 0.7 },
  thames: { label: 'Thames & Mercer Bank', region: 'EMEA', scale: 1.3 },
  rhinegold: { label: 'Rhinegold Landesbank', region: 'EMEA', scale: 1.05 },
  lumiere: { label: 'Banque Lumière', region: 'EMEA', scale: 0.95 },
  nordic: { label: 'Nordic Fjord Bank', region: 'EMEA', scale: 0.6 },
  alpine: { label: 'Alpine Helvetic AG', region: 'EMEA', scale: 1.1 },
  iberia: { label: 'Banco Iberia Global', region: 'EMEA', scale: 0.75 },
  sakura: { label: 'Sakura Trust Bank', region: 'APAC', scale: 1.15 },
  harbour: { label: 'Harbour Pacific Bank', region: 'APAC', scale: 0.9 },
  meridian: { label: 'Meridian Asia Securities', region: 'APAC', scale: 0.65 },
  southerncross: { label: 'Southern Cross Banking Corp', region: 'APAC', scale: 0.8 },
};

const ALL_COUNTERPARTIES = Object.keys(COUNTERPARTIES);

const COUNTERPARTY_SCOPES = {
  all: { label: `All counterparties (${ALL_COUNTERPARTIES.length})`, counterparties: ALL_COUNTERPARTIES },
  ...Object.fromEntries(ALL_COUNTERPARTIES.map((key) => [key, { label: COUNTERPARTIES[key].label, counterparties: [key] }])),
};

const ASSET_CLASSES = {
  irs: { label: 'Interest Rate Swaps', baseNotionalMm: 4200, compressionPct: [42, 58], rwaFactor: 0.016 },
  fxfwd: { label: 'FX Forwards & Swaps', baseNotionalMm: 2600, compressionPct: [35, 52], rwaFactor: 0.022 },
  fxopt: { label: 'FX Options', baseNotionalMm: 1100, compressionPct: [28, 44], rwaFactor: 0.031 },
  cds: { label: 'Credit Default Swaps', baseNotionalMm: 900, compressionPct: [38, 55], rwaFactor: 0.045 },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Capitolis Portfolio Optimization compression preview request:',
  '- Service: `app/services/verticals/a6fe3aeb.js`',
  '- Route: `app/routes/verticals/a6fe3aeb.js`',
  '- Page: `app/public/verticals/a6fe3aeb.html` (served at `/capitolis`)',
  '- Test: `tests/a6fe3aeb-compression-preview.test.js`',
  '',
  'Compression previews with the default "All counterparties" scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call via Datadog / Sentry.',
  'The culprit is `fetchCounterpartyPortfolios` in the service.',
  'Find the root cause of the latency and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-counterparty portfolio feed latency.',
  'Preserve the response payload for every scope, including the order of per-counterparty results and the summary (gross notional, notional eliminated, reduction %, capital released).',
  'Run `npx jest tests/a6fe3aeb-compression-preview.test.js --runInBand` and `npm run lint`.',
  'Verify the default compression preview at `/capitolis` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashKey(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function fetchPortfolioSnapshot(request, counterpartyKey) {
  const [min, max] = PORTFOLIO_FEED_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const cp = COUNTERPARTIES[counterpartyKey];
  const ac = ASSET_CLASSES[request.assetClass];
  const hash = hashKey(`${request.institution.toLowerCase()}:${request.assetClass}:${counterpartyKey}`);

  const grossNotionalUsdMm = Math.round(ac.baseNotionalMm * cp.scale * (0.8 + (hash % 41) / 100));
  const [lo, hi] = ac.compressionPct;
  const reductionPct = lo + ((hash >>> 8) % (hi - lo + 1));
  const eliminatedNotionalUsdMm = Math.round((grossNotionalUsdMm * reductionPct) / 100);
  const tradeCount = 180 + ((hash >>> 4) % 1600);
  const tradesTerminated = Math.round((tradeCount * reductionPct) / 100);

  return {
    counterparty: counterpartyKey,
    label: cp.label,
    region: cp.region,
    tradeCount,
    tradesTerminated,
    grossNotionalUsdMm,
    eliminatedNotionalUsdMm,
    residualNotionalUsdMm: grossNotionalUsdMm - eliminatedNotionalUsdMm,
    reductionPct,
  };
}

/**
 * Pull the latest bilateral portfolio snapshot from each counterparty's trade
 * feed for the compression cycle. Results are returned in the scope's
 * counterparty order so the preview table lines up with the counterparty menu.
 */
async function fetchCounterpartyPortfolios(request, counterparties) {
  const snapshots = [];
  for (const counterpartyKey of counterparties) {
    snapshots.push(await fetchPortfolioSnapshot(request, counterpartyKey));
  }
  return snapshots;
}

function summarize(snapshots, assetClass) {
  const gross = snapshots.reduce((sum, s) => sum + s.grossNotionalUsdMm, 0);
  const eliminated = snapshots.reduce((sum, s) => sum + s.eliminatedNotionalUsdMm, 0);
  const trades = snapshots.reduce((sum, s) => sum + s.tradeCount, 0);
  const terminated = snapshots.reduce((sum, s) => sum + s.tradesTerminated, 0);
  const top = snapshots.reduce((best, s) => (!best || s.eliminatedNotionalUsdMm > best.eliminatedNotionalUsdMm ? s : best), null);
  return {
    counterpartiesAnalyzed: snapshots.length,
    tradeCount: trades,
    tradesTerminated: terminated,
    grossNotionalUsdMm: gross,
    eliminatedNotionalUsdMm: eliminated,
    residualNotionalUsdMm: gross - eliminated,
    reductionPct: gross ? Math.round((eliminated / gross) * 1000) / 10 : 0,
    capitalReleasedUsdMm: Math.round(eliminated * ASSET_CLASSES[assetClass].rwaFactor * 10) / 10,
    topCounterparty: top ? { counterparty: top.counterparty, label: top.label, eliminatedNotionalUsdMm: top.eliminatedNotionalUsdMm } : null,
  };
}

function validatePreview(data) {
  const validName = typeof data.name === 'string' && data.name.length >= 2 && data.name.length <= 80;
  const validInstitution = typeof data.institution === 'string' && data.institution.length >= 2 && data.institution.length <= 120;
  const validEmail = typeof data.email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(data.email) && data.email.length <= 254;
  const validAsset = Object.hasOwn(ASSET_CLASSES, data.assetClass);
  const validScope = Object.hasOwn(COUNTERPARTY_SCOPES, data.scope);

  if (!validName || !validInstitution || !validEmail || !validAsset || !validScope) {
    const error = new Error('Enter your name, institution, a valid business email, an asset class and a counterparty scope.');
    error.name = 'ValidationError';
    error.code = 'COMPRESSION_PREVIEW_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, counterpartiesAnalyzed, data,
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
      asset_class: data.assetClass,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      counterpartiesAnalyzed,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/a6fe3aeb.js — fetchCounterpartyPortfolios',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Capitolis Compression Preview',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'a6fe3aeb',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'scope', value: data.scope },
      { key: 'asset_class', value: data.assetClass },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      counterpartiesAnalyzed,
      datadogMetric: 'compression_preview.latency',
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
    logger.error('Failed to create Devin session for Capitolis compression preview latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

function textOr(value, fallback) {
  return value === undefined || value === null ? fallback : String(value).trim();
}

async function runCompressionPreview(data = {}) {
  const startTime = Date.now();
  const previewId = `CAP-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    name: textOr(requestData.name, 'Alex Morgan'),
    institution: textOr(requestData.institution, 'Global Markets Bank'),
    email: textOr(requestData.email, 'alex.morgan@globalmarkets.example').toLowerCase(),
    assetClass: textOr(requestData.assetClass, 'irs').toLowerCase(),
    scope: textOr(requestData.scope, 'all').toLowerCase(),
  };

  validatePreview(normalized);

  const scope = COUNTERPARTY_SCOPES[normalized.scope];

  logger.info('Running Capitolis compression preview', {
    previewId,
    assetClass: normalized.assetClass,
    scope: normalized.scope,
    counterparties: scope.counterparties.length,
    service: SERVICE,
    route: ROUTE,
  });

  const snapshots = await fetchCounterpartyPortfolios(normalized, scope.counterparties);
  const summary = summarize(snapshots, normalized.assetClass);
  const durationMs = Date.now() - startTime;

  incrementMetric('compression_preview.success', { route: ROUTE, scope: normalized.scope, asset_class: normalized.assetClass });
  recordTiming('compression_preview.latency', durationMs, { route: ROUTE, scope: normalized.scope });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('compression_preview.latency_budget_breach', {
      route: ROUTE,
      scope: normalized.scope,
      asset_class: normalized.assetClass,
    });
    logger.warn('Capitolis compression preview exceeded latency budget', {
      previewId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      counterpartiesAnalyzed: snapshots.length,
      scope: normalized.scope,
      service: SERVICE,
    });
    logger.warn('Capitolis compression preview latency breach — triggering Devin session', {
      previewId,
      service: SERVICE,
      route: ROUTE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: previewId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      counterpartiesAnalyzed: snapshots.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    previewId,
    name: normalized.name,
    institution: normalized.institution,
    assetClass: { key: normalized.assetClass, label: ASSET_CLASSES[normalized.assetClass].label },
    scope: { key: normalized.scope, label: scope.label },
    counterpartiesAnalyzed: snapshots.length,
    counterparties: snapshots,
    summary,
    durationMs,
  };
}

module.exports = {
  runCompressionPreview,
  summarize,
  COUNTERPARTIES,
  ALL_COUNTERPARTIES,
  COUNTERPARTY_SCOPES,
  ASSET_CLASSES,
  PORTFOLIO_FEED_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
