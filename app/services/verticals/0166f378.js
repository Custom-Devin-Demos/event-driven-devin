/**
 * Fidelity — Portfolio Summary (customer 0166f378).
 *
 * The summary grid loads every position the customer owns with its latest close from
 * Snowflake (live via app/services/snowflake-client.js when SNOWFLAKE_* is configured,
 * otherwise the embedded emulator in ./0166f378-snowflake-emulator.js). The request has
 * a 1500ms latency budget; a breach raises LatencyBudgetExceeded → Sentry + Slack alert
 * + an instant Devin session whose prompt carries the Snowflake query id and profile.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const snowflakeClient = require('../snowflake-client');
const emulator = require('./0166f378-snowflake-emulator');
const { PORTFOLIO, DATABASE, SCHEMA } = require('./0166f378-portfolio');
const { buildPositionsQuery, positionsQueryBindings, PRICE_HISTORY_TABLE } = require('./0166f378-positions-query');

const CUSTOMER = '0166f378';
const SERVICE = 'fidelity-portfolio-summary';
const ROUTE = '/api/0166f378/portfolio-summary';
const SLACK_MEMBER_ID = process.env.FIDELITY_SLACK_MEMBER_ID || 'U08S7AVJ478';
const LATENCY_SLO = { budgetMs: Number(process.env.FIDELITY_LATENCY_BUDGET_MS) || 1500 };
const ALERT_COOLDOWN_MS = Number(process.env.FIDELITY_ALERT_COOLDOWN_MS) || 10 * 60 * 1000;
const DAY_MS = 86400000;

let lastAlertAt = 0;

function snowflakeMode() {
  if (process.env.SNOWFLAKE_0166F378_MODE === 'emulator') return 'emulator';
  return snowflakeClient.isConfigured() ? 'live' : 'emulator';
}

function buildRemediationDirective(context) {
  const { profile = {}, queryId, durationMs, budgetMs, rowsReturned, mode } = context;
  const pruning = profile.partitionsTotal
    ? `${profile.partitionsScanned}/${profile.partitionsTotal} micro-partitions of PRICE_HISTORY scanned (${profile.bytesScanned ? `${(profile.bytesScanned / 1e6).toFixed(1)} MB` : 'bytes n/a'})`
    : 'partition pruning stats unavailable';
  return [
    '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
    '',
    'The slow code path is the Fidelity Portfolio Summary load, which reads positions + latest prices from Snowflake:',
    '- Service: `app/services/verticals/0166f378.js` (`loadPortfolioSummary`)',
    '- SQL: `app/services/verticals/0166f378-positions-query.js` (`buildPositionsQuery`)',
    '- Snowflake driver: `app/services/snowflake-client.js` (live) / `app/services/verticals/0166f378-snowflake-emulator.js` (local)',
    '- Route: `app/routes/verticals/0166f378.js`',
    '- Page: `app/public/verticals/0166f378.html` (served at `/fidelity`)',
    '- Tests: `tests/0166f378-portfolio-summary.test.js`; e2e: `npm run e2e:fidelity-latency` (Playwright, needs the server on PORT)',
    '',
    `Observed: ${ROUTE} took ${durationMs}ms against a ${budgetMs}ms budget. Snowflake query ${queryId} (${mode}) returned ${rowsReturned} rows to the app; ${pruning}.`,
    `Table ${PRICE_HISTORY_TABLE} holds ~10 years of daily closes for ~1500 symbols (~3.9M rows), naturally clustered by PRICE_DATE.`,
    '',
    'Zoom in on the query. Determine why Snowflake cannot prune micro-partitions and why the app receives one row per historical trading day per position instead of one row per position. Fix the SQL (and only what is needed around it) so the warehouse returns the latest close per position for the as-of date, then verify with the jest test and the Playwright e2e latency test that the load is under budget.',
    'Keep the 1500ms budget, the breach alert, the response shape, and the emulator cost model intact.',
    'Run `npx jest tests/0166f378-portfolio-summary.test.js --runInBand` and `npm run lint`.',
    'Open a pull request against `main` with before/after latency and query-profile numbers in the description.',
  ].join('\n');
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function epochDaysToIso(value) {
  if (value === null || value === undefined) return null;
  if (/^-?\d+$/.test(String(value))) return new Date(toNumber(value) * DAY_MS).toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function latestTradingDay(date) {
  const d = new Date(date);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

async function fetchLiveQueryProfile(queryId) {
  const stats = await snowflakeClient.executeStatement(
    `SELECT OPERATOR_TYPE, OPERATOR_STATISTICS, OPERATOR_ATTRIBUTES FROM TABLE(GET_QUERY_OPERATOR_STATS('${queryId}'))`,
    { database: DATABASE, schema: SCHEMA, timeoutSeconds: 30 },
  );
  const history = await snowflakeClient.executeStatement(
    `SELECT TOTAL_ELAPSED_TIME, EXECUTION_TIME, COMPILATION_TIME, BYTES_SCANNED, ROWS_PRODUCED, WAREHOUSE_SIZE FROM TABLE(INFORMATION_SCHEMA.QUERY_HISTORY_BY_USER(RESULT_LIMIT => 100)) WHERE QUERY_ID = '${queryId}'`,
    { database: DATABASE, schema: SCHEMA, timeoutSeconds: 30 },
  );
  const parse = (value) => { try { return JSON.parse(value || '{}'); } catch { return {}; } };
  const scan = stats.rows
    .filter((row) => row.OPERATOR_TYPE === 'TableScan')
    .map((row) => ({ stats: parse(row.OPERATOR_STATISTICS), attrs: parse(row.OPERATOR_ATTRIBUTES) }))
    .find((row) => String(row.attrs.table_name || '').toUpperCase().includes('PRICE_HISTORY'));
  const dedup = stats.rows.some((row) => ['WindowFunction', 'Aggregate'].includes(row.OPERATOR_TYPE));
  const h = history.rows[0] || {};
  return {
    source: 'snowflake',
    warehouseSize: h.WAREHOUSE_SIZE || null,
    partitionsScanned: scan ? toNumber(scan.stats.pruning && scan.stats.pruning.partitions_scanned) : null,
    partitionsTotal: scan ? toNumber(scan.stats.pruning && scan.stats.pruning.partitions_total) : null,
    bytesScanned: toNumber(h.BYTES_SCANNED),
    rowsScanned: scan ? toNumber(scan.stats.output_rows) : null,
    rowsProduced: toNumber(h.ROWS_PRODUCED),
    pruned: scan ? toNumber(scan.stats.pruning && scan.stats.pruning.partitions_scanned) < toNumber(scan.stats.pruning && scan.stats.pruning.partitions_total) : null,
    dedupInWarehouse: dedup,
    executionTimeMs: toNumber(h.EXECUTION_TIME),
    compilationTimeMs: toNumber(h.COMPILATION_TIME),
    totalElapsedMs: toNumber(h.TOTAL_ELAPSED_TIME),
  };
}

async function queryPositions(ownerId, asOf) {
  const statement = buildPositionsQuery();
  const bindings = positionsQueryBindings(ownerId, asOf);
  const mode = snowflakeMode();
  const result = mode === 'live'
    ? await snowflakeClient.executeStatement(statement, {
      bindings, database: DATABASE, schema: SCHEMA, timeoutSeconds: 90, parameters: { USE_CACHED_RESULT: 'false' },
    })
    : await emulator.executeStatement(statement, { bindings });
  return { ...result, mode, statement };
}

/** Keep the first (latest-dated) row per position: rows arrive ordered by position, date desc. */
function latestPricePerPosition(rows) {
  const latest = new Map();
  for (const row of rows) {
    if (!latest.has(row.POSITION_ID)) latest.set(row.POSITION_ID, row);
  }
  return [...latest.values()];
}

function buildSummary(rows, asOf) {
  const positions = latestPricePerPosition(rows).map((row) => {
    const quantity = toNumber(row.QUANTITY);
    const price = toNumber(row.CLOSE_PRICE);
    const prevClose = toNumber(row.PREV_CLOSE);
    const costBasis = toNumber(row.COST_BASIS);
    const isCash = row.ASSET_CLASS === 'Money Market';
    const marketValue = isCash ? quantity : quantity * price;
    const dayChange = isCash ? 0 : quantity * (price - prevClose);
    return {
      positionId: row.POSITION_ID,
      accountId: row.ACCOUNT_ID,
      symbol: row.SYMBOL,
      description: row.DESCRIPTION,
      assetClass: row.ASSET_CLASS,
      quantity,
      lastPrice: isCash ? 1 : price,
      priceDate: epochDaysToIso(row.PRICE_DATE),
      dayChange: Math.round(dayChange * 100) / 100,
      dayChangePct: isCash || !prevClose ? 0 : Math.round(((price - prevClose) / prevClose) * 10000) / 100,
      marketValue: Math.round(marketValue * 100) / 100,
      costBasis,
      gainLoss: Math.round((marketValue - costBasis) * 100) / 100,
      gainLossPct: costBasis ? Math.round(((marketValue - costBasis) / costBasis) * 10000) / 100 : 0,
    };
  });

  const accounts = PORTFOLIO.accounts.map((account) => {
    const held = positions.filter((p) => p.accountId === account.accountId);
    const marketValue = held.reduce((sum, p) => sum + p.marketValue, 0);
    const dayChange = held.reduce((sum, p) => sum + p.dayChange, 0);
    return {
      ...account,
      marketValue: Math.round(marketValue * 100) / 100,
      dayChange: Math.round(dayChange * 100) / 100,
      positions: held,
    };
  });
  const totalValue = accounts.reduce((sum, a) => sum + a.marketValue, 0);
  const totalDayChange = accounts.reduce((sum, a) => sum + a.dayChange, 0);
  return {
    asOf,
    owner: PORTFOLIO.owner,
    accounts,
    totals: {
      marketValue: Math.round(totalValue * 100) / 100,
      dayChange: Math.round(totalDayChange * 100) / 100,
      dayChangePct: totalValue ? Math.round((totalDayChange / (totalValue - totalDayChange)) * 10000) / 100 : 0,
      positionCount: positions.length,
    },
  };
}

async function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, snowflake, data,
  } = context;
  const error = new Error(`GET ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  let profile = snowflake.profile || null;
  if (!profile && snowflake.mode === 'live') {
    try {
      profile = await fetchLiveQueryProfile(snowflake.queryId);
    } catch (profileError) {
      logger.warn('Could not fetch Snowflake query profile for latency breach', { requestId, queryId: snowflake.queryId, error: profileError.message });
    }
  }
  const alertContext = {
    requestId,
    durationMs,
    budgetMs,
    snowflakeMode: snowflake.mode,
    snowflakeQueryId: snowflake.queryId,
    snowflakeDurationMs: snowflake.durationMs,
    rowsReturned: snowflake.rowsReturned,
    partitionsScanned: profile ? profile.partitionsScanned : null,
    partitionsTotal: profile ? profile.partitionsTotal : null,
    bytesScanned: profile ? profile.bytesScanned : null,
    ownerId: data.ownerId,
  };

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE, service: SERVICE, alert_path: 'latency', snowflakeMode: snowflake.mode, snowflakeQueryId: snowflake.queryId,
    },
    extra: alertContext,
  });

  const delivery = await createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'loadPortfolioSummary(app/services/verticals/0166f378)',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Fidelity Portfolio Summary',
    promptAppendix: buildRemediationDirective({
      profile, queryId: snowflake.queryId, durationMs, budgetMs, rowsReturned: snowflake.rowsReturned, mode: snowflake.mode,
    }),
    customer: CUSTOMER,
    skipVulnerablePr: true,
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'durationMs', value: String(durationMs) },
      { key: 'budgetMs', value: String(budgetMs) },
      { key: 'snowflakeQueryId', value: String(snowflake.queryId) },
      { key: 'rowsReturned', value: String(snowflake.rowsReturned) },
      { key: 'partitionsScanned', value: profile && profile.partitionsTotal ? `${profile.partitionsScanned}/${profile.partitionsTotal}` : 'n/a' },
    ],
    extra: alertContext,
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
  });
  if (!delivery) {
    throw new Error('alert was not delivered to Slack or Teams');
  }
}

/**
 * Load the Portfolio Summary for one customer.
 * `data.reproduction` suppresses the alert pipeline (synthetic / local runs).
 */
async function loadPortfolioSummary(data = {}) {
  const requestId = data.requestId || uuidv4();
  const ownerId = data.ownerId || PORTFOLIO.ownerId;
  const asOf = latestTradingDay(data.asOf ? new Date(`${data.asOf}T00:00:00Z`) : new Date());
  const startedAt = Date.now();

  logger.info('Loading Fidelity portfolio summary', { requestId, ownerId, asOf, snowflakeMode: snowflakeMode() });
  const result = await queryPositions(ownerId, asOf);
  const summary = buildSummary(result.rows, asOf);
  const durationMs = Date.now() - startedAt;
  const breached = durationMs > LATENCY_SLO.budgetMs;

  recordTiming('portfolio_summary.latency', durationMs, { service: SERVICE, snowflake_mode: result.mode, breached: String(breached) });
  recordTiming('portfolio_summary.snowflake_query_ms', result.durationMs, { service: SERVICE, snowflake_mode: result.mode });
  incrementMetric('portfolio_summary.snowflake_rows_returned', result.rows.length, { service: SERVICE });

  const snowflake = {
    mode: result.mode,
    queryId: result.queryId,
    durationMs: result.durationMs,
    rowsReturned: result.rows.length,
    profile: result.profile || null,
    database: DATABASE,
    schema: SCHEMA,
    statement: result.statement,
  };

  if (breached) {
    incrementMetric('portfolio_summary.latency_budget_breach', 1, { service: SERVICE, snowflake_mode: result.mode });
    logger.warn('Fidelity portfolio summary exceeded latency budget', {
      requestId, durationMs, budgetMs: LATENCY_SLO.budgetMs, snowflakeQueryId: result.queryId, rowsReturned: result.rows.length, reproduction: Boolean(data.reproduction),
    });
    const now = Date.now();
    if (data.reproduction) {
      logger.info('Reproduction request: skipping Sentry/Slack/Devin alert', { requestId });
    } else if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
      logger.info('Latency breach alert suppressed by cooldown', { requestId, cooldownMs: ALERT_COOLDOWN_MS });
    } else {
      lastAlertAt = now;
      reportLatencyBreach({
        requestId, durationMs, budgetMs: LATENCY_SLO.budgetMs, snowflake, data: { ...data, ownerId },
      }).catch((alertError) => {
        if (lastAlertAt === now) lastAlertAt = 0;
        logger.error('Failed to create Devin session for Fidelity portfolio latency breach', { error: alertError.message, requestId });
      });
    }
  } else {
    logger.info('Fidelity portfolio summary loaded', { requestId, durationMs, rowsReturned: result.rows.length });
  }

  return {
    success: true,
    requestId,
    ...summary,
    backend: {
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      breached,
      snowflake,
    },
  };
}

function resetAlertCooldown() {
  lastAlertAt = 0;
}

module.exports = {
  loadPortfolioSummary,
  buildSummary,
  latestPricePerPosition,
  buildRemediationDirective,
  resetAlertCooldown,
  snowflakeMode,
  LATENCY_SLO,
  ROUTE,
  SERVICE,
  CUSTOMER,
};
