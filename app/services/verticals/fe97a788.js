/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-fe97a788-endpoint-query';
const ROUTE = '/api/fe97a788/query';
const SLACK_MEMBER_ID = process.env.TINYBIRD_SLACK_MEMBER_ID || 'U08S7AVJ478';

const LATENCY_SLO = { budgetMs: 3000 };
const SHARD_READ_POLICY = { latencyMs: [450, 550] };

const PIPES = {
  top_pages: {
    label: 'top_pages',
    datasource: 'analytics_events',
    dimension: 'pathname',
    keys: [
      '/',
      '/pricing',
      '/docs',
      '/blog/clickhouse-vs-postgres',
      '/product/managed-clickhouse',
      '/customer-stories',
      '/docs/forward/quickstarts',
      '/templates',
    ],
  },
  top_sources: {
    label: 'top_sources',
    datasource: 'analytics_events',
    dimension: 'referrer',
    keys: [
      'google.com',
      'github.com',
      'news.ycombinator.com',
      'x.com',
      'linkedin.com',
      'reddit.com',
      'chatgpt.com',
      'direct',
    ],
  },
  top_locations: {
    label: 'top_locations',
    datasource: 'analytics_events',
    dimension: 'country',
    keys: ['US', 'ES', 'DE', 'GB', 'IN', 'FR', 'BR', 'CA'],
  },
};

const TIME_RANGES = {
  '1h': { label: 'Last hour', scale: 1 },
  '24h': { label: 'Last 24 hours', scale: 24 },
  '7d': { label: 'Last 7 days', scale: 168 },
};

const CLUSTER_SHARDS = Array.from({ length: 14 }, (_, index) => (
  `shard-${String(index + 1).padStart(2, '0')}`
));

const SCOPE_OPTIONS = {
  cluster: { label: 'Distributed — all 14 shards', shards: CLUSTER_SHARDS },
  shard: { label: 'Single shard — shard-01', shards: ['shard-01'] },
  mv: { label: 'Materialized view (pre-aggregated)', shards: ['mv_rollup'] },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Tinybird endpoint query request:',
  '- Service: `app/services/verticals/fe97a788.js`',
  '- Route: `app/routes/verticals/fe97a788.js`',
  '- Page: `app/public/verticals/fe97a788.html` (served at `/tinybird`)',
  '- Test: `tests/fe97a788-endpoint-query.test.js`',
  '',
  'Endpoint queries with the default distributed (all 14 shards) scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency in `collectShardResults` and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-shard read latency.',
  'Preserve the response payload for every scope, including shard order in `shardResults` and the first-seen tie-break in `mergeShardResults`.',
  'Run `npx jest tests/fe97a788-endpoint-query.test.js --runInBand` and `npm run lint`.',
  'Verify the default query at `/tinybird` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashQueryResult(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

async function queryShard(pipeKey, timeRangeKey, shard) {
  const [min, max] = SHARD_READ_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const pipe = PIPES[pipeKey];
  const scale = TIME_RANGES[timeRangeKey].scale;
  const rows = pipe.keys.map((key) => ({
    key,
    hits: (hashQueryResult(`${pipeKey}:${timeRangeKey}:${shard}:${key}`) % 900 + 100) * scale,
  }));
  const totalHits = rows.reduce((total, row) => total + row.hits, 0);

  return {
    shard,
    rows,
    rowsRead: totalHits * 12,
    bytesRead: totalHits * 12 * 184,
  };
}

/**
 * Read shards in cluster order; mergeShardResults breaks hit-count ties by that order.
 */
async function collectShardResults(pipeKey, timeRangeKey, shards) {
  const results = [];
  for (const shard of shards) results.push(await queryShard(pipeKey, timeRangeKey, shard));
  return results;
}

function mergeShardResults(shardResults, limit = 5) {
  const totals = new Map();
  for (const shardResult of shardResults) {
    for (const row of shardResult.rows) {
      totals.set(row.key, (totals.get(row.key) || 0) + row.hits);
    }
  }

  return Array.from(totals, ([key, hits]) => ({ key, hits }))
    .sort((left, right) => right.hits - left.hits)
    .slice(0, limit);
}

function normalizeQuery(data) {
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    pipe: String(requestData.pipe === undefined ? 'top_pages' : requestData.pipe).trim().toLowerCase(),
    timeRange: String(requestData.timeRange === undefined ? '24h' : requestData.timeRange).trim().toLowerCase(),
    scope: String(requestData.scope === undefined ? 'cluster' : requestData.scope).trim().toLowerCase(),
  };

  if (!Object.hasOwn(PIPES, normalized.pipe)
    || !Object.hasOwn(TIME_RANGES, normalized.timeRange)
    || !Object.hasOwn(SCOPE_OPTIONS, normalized.scope)) {
    const error = new Error('Enter valid query parameters.');
    error.name = 'ValidationError';
    error.code = 'QUERY_PARAMS_INVALID';
    error.statusCode = 400;
    throw error;
  }

  return normalized;
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, shardsQueried, data,
  } = context;
  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      pipe: data.pipe,
      scope: data.scope,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      shardsQueried,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/fe97a788.js — collectShardResults',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Tinybird Endpoint Query',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'fe97a788',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'pipe', value: data.pipe },
      { key: 'scope', value: data.scope },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      shardsQueried,
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
    logger.error('Failed to create Devin session for Tinybird endpoint-query latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function runEndpointQuery(data = {}) {
  const startTime = Date.now();
  const queryId = `TB-${uuidv4().slice(0, 8).toUpperCase()}`;
  const normalized = normalizeQuery(data);
  const pipe = PIPES[normalized.pipe];
  const timeRange = TIME_RANGES[normalized.timeRange];
  const scope = SCOPE_OPTIONS[normalized.scope];
  const shards = scope.shards;

  logger.info('Running Tinybird endpoint query', {
    queryId,
    pipe: normalized.pipe,
    timeRange: normalized.timeRange,
    scope: normalized.scope,
    service: SERVICE,
    route: ROUTE,
  });

  const shardResults = await collectShardResults(normalized.pipe, normalized.timeRange, shards);
  const rows = mergeShardResults(shardResults);
  const rowsRead = shardResults.reduce((total, result) => total + result.rowsRead, 0);
  const bytesRead = shardResults.reduce((total, result) => total + result.bytesRead, 0);
  const durationMs = Date.now() - startTime;

  incrementMetric('endpoint_query.success', {
    route: ROUTE,
    pipe: normalized.pipe,
    scope: normalized.scope,
  });
  recordTiming('endpoint_query.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('endpoint_query.latency_budget_breach', {
      route: ROUTE,
      pipe: normalized.pipe,
      scope: normalized.scope,
    });
    logger.warn('Tinybird endpoint query exceeded latency budget', {
      queryId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      shardsQueried: shards.length,
      pipe: normalized.pipe,
      scope: normalized.scope,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: queryId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      shardsQueried: shards.length,
      data: {
        ...normalized,
        devinUserId: data.devinUserId,
        devinOrgId: data.devinOrgId,
        devinEmail: data.devinEmail,
      },
    }));
  }

  return {
    success: true,
    queryId,
    pipe: {
      key: normalized.pipe,
      label: pipe.label,
      datasource: pipe.datasource,
      dimension: pipe.dimension,
      endpoint: `/v0/pipes/${normalized.pipe}.json`,
    },
    timeRange: {
      key: normalized.timeRange,
      label: timeRange.label,
    },
    scope: {
      key: normalized.scope,
      label: scope.label,
    },
    shardsQueried: shards.length,
    rows,
    rowsRead,
    bytesRead,
    shardResults: shardResults.map(({ shard, rowsRead: shardRowsRead, bytesRead: shardBytesRead }) => ({
      shard,
      rowsRead: shardRowsRead,
      bytesRead: shardBytesRead,
    })),
    durationMs,
  };
}

module.exports = {
  runEndpointQuery,
  mergeShardResults,
  PIPES,
  TIME_RANGES,
  SCOPE_OPTIONS,
  CLUSTER_SHARDS,
  SHARD_READ_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
