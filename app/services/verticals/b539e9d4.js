const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { resolveSecurity } = require('./b539e9d4-security-master');

const CUSTOMER = 'b539e9d4';
const SERVICE = 'index-constituent-service';
const ROUTE = '/api/b539e9d4/rebalance';
const ENGINE_VERSION = '4.12.0';
const WEIGHT_TOLERANCE = 0.01;
const FEED_DEADLINE = '08:00 ET';
const MARKET_OPEN = '09:30 ET';

const INDICES = [
  { id: 'SPX', name: 'S&P 500', constituents: 503, marketCap: 52.4e12, divisor: 8642.37 },
  { id: 'MID', name: 'S&P MidCap 400', constituents: 400, marketCap: 3.18e12, divisor: 1102.58 },
  { id: 'SML', name: 'S&P SmallCap 600', constituents: 600, marketCap: 1.62e12, divisor: 1197.04 },
];

const CHANNELS = [
  { id: 'etf', label: 'ETF issuers & index funds', audience: 'Pro-forma constituent files (SFTP)', recipients: 412 },
  { id: 'exchanges', label: 'Exchanges & derivatives venues', audience: 'Opening-cross reference data', recipients: 38 },
  { id: 'vendors', label: 'Market data vendors', audience: 'Bloomberg, LSEG, FactSet, ICE', recipients: 214 },
  { id: 'clients', label: 'Index licensees', audience: 'Client portal & API', recipients: 576 },
];

// Announced after the close; effective prior to the open on the next trading day.
const NOTICES = [
  {
    noticeId: 'SPX-26-117',
    indexId: 'SPX',
    headline: 'Kestrel Aerospace Holdings Class B to join the S&P 500; Halvorsen Retail Group moves to the S&P MidCap 400',
    add: { ticker: 'KSTL.B', name: 'Kestrel Aerospace Holdings Inc. Class B', cusip: '48800A200', isin: 'US48800A2006' },
    delete: { ticker: 'HLVR.N', name: 'Halvorsen Retail Group Inc.' },
  },
  {
    noticeId: 'MID-26-089',
    indexId: 'MID',
    headline: 'Halvorsen Retail Group to replace Brightwater Bancorp in the S&P MidCap 400 following its acquisition',
    add: { ticker: 'HLVR.N', name: 'Halvorsen Retail Group Inc.', cusip: '40622R104', isin: 'US40622R1041' },
    delete: { ticker: 'BWTR', name: 'Brightwater Bancorp' },
  },
  {
    noticeId: 'SML-26-142',
    indexId: 'SML',
    headline: 'Pinecrest Laboratories to replace Orchard Lane Foods in the S&P SmallCap 600',
    add: { ticker: 'PNCL.OQ', name: 'Pinecrest Laboratories Inc.', cusip: '72300K105', isin: 'US72300K1051' },
    delete: { ticker: 'OLF', name: 'Orchard Lane Foods Co.' },
  },
];

const STAGES = [
  { id: 'ingest', name: 'Ingest index notices', detail: 'Announced adds and deletes for the effective date' },
  { id: 'resolve', name: 'Resolve securities', detail: 'Security master: ticker to CUSIP, ISIN, share class' },
  { id: 'calculate', name: 'Calculate pro-forma', detail: 'Index shares, IWF, weights, divisor adjustment' },
  { id: 'build', name: 'Build pro-forma files', detail: 'Constituent files per index for the client feed' },
  { id: 'reconcile', name: 'Reconcile vs. notices', detail: 'Identifiers and weights must match the announcement' },
  { id: 'release', name: 'Release client feed', detail: 'ETF issuers, exchanges, vendors, licensees' },
];

const PRIOR_REBALANCES = [
  { daysAgo: 3, notices: 2, released: '18:41 ET' },
  { daysAgo: 8, notices: 1, released: '18:37 ET' },
  { daysAgo: 14, notices: 3, released: '18:52 ET' },
  { daysAgo: 21, notices: 2, released: '18:44 ET' },
];

const RUNS = [];
const state = { status: 'standby', lastError: null, feed: null, nextSeq: 1, generation: 0 };

function pad(value) {
  return String(value).padStart(2, '0');
}

function isoDate(date) {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

function easternParts(now) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', timeZoneName: 'shortOffset',
  }).formatToParts(now).reduce((acc, part) => Object.assign(acc, { [part.type]: part.value }), {});
}

const NYSE_HOLIDAYS = new Set([
  '2026-01-01', '2026-01-19', '2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03',
  '2026-09-07', '2026-11-26', '2026-12-25',
  '2027-01-01', '2027-01-18', '2027-02-15', '2027-03-26', '2027-05-31', '2027-06-18', '2027-07-05',
  '2027-09-06', '2027-11-25', '2027-12-24',
]);

function isTradingDay(date) {
  return date.getUTCDay() !== 0 && date.getUTCDay() !== 6 && !NYSE_HOLIDAYS.has(isoDate(date));
}

function shiftTradingDays(date, step) {
  const next = new Date(date.getTime());
  do {
    next.setUTCDate(next.getUTCDate() + step);
  } while (!isTradingDay(next));
  return next;
}

function calendar(now = new Date()) {
  const parts = easternParts(now);
  let announced = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (!isTradingDay(announced)) announced = shiftTradingDays(announced, -1);
  const effective = shiftTradingDays(announced, 1);
  const offset = (easternParts(new Date(`${isoDate(effective)}T14:30:00Z`)).timeZoneName || 'GMT-5').replace('GMT', '') || '-5';
  const sign = offset.startsWith('-') ? '-' : '+';
  const hours = pad(Math.abs(parseInt(offset, 10)));
  return {
    announcedDate: isoDate(announced),
    effectiveDate: isoDate(effective),
    marketOpenAt: new Date(`${isoDate(effective)}T09:30:00${sign}${hours}:00`).toISOString(),
  };
}

function dateLabel(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC',
  });
}

function round(value, places) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function floatMarketCap(security) {
  return security.sharesOutstanding * security.iwf * security.lastClose;
}

function indexById(id) {
  return INDICES.find((index) => index.id === id);
}

function announcedWeight(notice) {
  const index = indexById(notice.indexId);
  const add = resolveAnnounced(notice.add);
  const removed = floatMarketCap(resolveAnnounced(notice.delete));
  const proFormaCap = index.marketCap - removed + floatMarketCap(add);
  return floatMarketCap(add) / proFormaCap;
}

// Notices publish the exact security; reconciliation compares the feed against them.
const ANNOUNCED_TERMS = {
  '48800A200': { sharesOutstanding: 312400000, iwf: 0.96, lastClose: 142.18 },
  '40622R104': { sharesOutstanding: 118600000, iwf: 0.99, lastClose: 61.42 },
  '72300K105': { sharesOutstanding: 54200000, iwf: 0.91, lastClose: 38.07 },
  BWTR: { sharesOutstanding: 96300000, iwf: 1, lastClose: 47.6 },
  'HLVR.N': { sharesOutstanding: 118600000, iwf: 0.99, lastClose: 61.42 },
  OLF: { sharesOutstanding: 41800000, iwf: 0.88, lastClose: 22.14 },
};

function resolveAnnounced(leg) {
  return ANNOUNCED_TERMS[leg.cusip] || ANNOUNCED_TERMS[leg.ticker];
}

function seedState() {
  const { announcedDate } = calendar();
  let cursor = new Date(`${announcedDate}T00:00:00Z`);
  RUNS.splice(0, RUNS.length, ...PRIOR_REBALANCES.map((prior) => {
    cursor = new Date(`${announcedDate}T00:00:00Z`);
    cursor.setUTCDate(cursor.getUTCDate() - prior.daysAgo);
    if (!isTradingDay(cursor)) cursor = shiftTradingDays(cursor, -1);
    const effective = isoDate(shiftTradingDays(cursor, 1));
    return {
      runId: `RBL-${effective.replace(/-/g, '')}-01`,
      effectiveDate: effective,
      status: 'released',
      notices: prior.notices,
      releasedAt: prior.released,
      failedStage: null,
      error: null,
    };
  }));
  state.status = 'standby';
  state.lastError = null;
  state.feed = null;
  state.nextSeq = 1;
  state.generation += 1;
}

seedState();

function stageName(id) {
  const stage = STAGES.find((item) => item.id === id);
  return stage ? stage.name : id;
}

function buildLine(notice, security) {
  const index = indexById(notice.indexId);
  const removed = floatMarketCap(resolveAnnounced(notice.delete));
  const added = floatMarketCap(security);
  const proFormaCap = index.marketCap - removed + added;
  return {
    noticeId: notice.noticeId,
    indexId: index.id,
    indexName: index.name,
    action: 'ADD',
    ticker: notice.add.ticker,
    name: security.name,
    shareClass: security.shareClass,
    cusip: security.cusip,
    isin: security.isin,
    indexShares: Math.round(security.sharesOutstanding * security.iwf),
    iwf: security.iwf,
    price: security.lastClose,
    weightPct: round((added / proFormaCap) * 100, 4),
    announcedCusip: notice.add.cusip,
    announcedWeightPct: round(announcedWeight(notice) * 100, 4),
    divisor: round(index.divisor * (proFormaCap / index.marketCap), 4),
    deleted: notice.delete.ticker,
    check: 'pending',
  };
}

function reconcile(line) {
  const weightDrift = Math.abs(line.weightPct - line.announcedWeightPct) / line.announcedWeightPct;
  if (line.cusip !== line.announcedCusip || weightDrift > WEIGHT_TOLERANCE) {
    line.check = 'mismatch';
    const error = new Error(
      `${line.indexName} pro-forma line ${line.ticker} carries CUSIP ${line.cusip} (Class ${line.shareClass || 'n/a'}) `
      + `but notice ${line.noticeId} announces ${line.announcedCusip}; pro-forma weight ${line.weightPct}% vs ${line.announcedWeightPct}% announced`,
    );
    error.name = 'ConstituentMismatchError';
    throw error;
  }
  line.check = 'ok';
}

function summarizeRun(run) {
  return {
    runId: run.runId,
    effectiveDate: run.effectiveDate,
    effectiveDateLabel: dateLabel(run.effectiveDate),
    status: run.status,
    notices: run.notices,
    releasedAt: run.releasedAt,
    failedStage: run.failedStage ? stageName(run.failedStage) : null,
    error: run.error,
  };
}

function getOverview() {
  const cal = calendar();
  const lines = state.feed ? state.feed.lines : [];
  return {
    service: SERVICE,
    engineVersion: ENGINE_VERSION,
    announcedDate: cal.announcedDate,
    announcedDateLabel: dateLabel(cal.announcedDate),
    effectiveDate: cal.effectiveDate,
    effectiveDateLabel: dateLabel(cal.effectiveDate),
    marketOpenAt: cal.marketOpenAt,
    marketOpen: MARKET_OPEN,
    feedDeadline: FEED_DEADLINE,
    status: state.status,
    lastError: state.lastError,
    nextRunId: `RBL-${cal.effectiveDate.replace(/-/g, '')}-${pad(state.nextSeq)}`,
    stages: STAGES,
    indices: INDICES,
    channels: CHANNELS,
    recipients: CHANNELS.reduce((sum, channel) => sum + channel.recipients, 0),
    notices: NOTICES.map((notice) => {
      const line = lines.find((item) => item.noticeId === notice.noticeId);
      return {
        noticeId: notice.noticeId,
        indexId: notice.indexId,
        indexName: indexById(notice.indexId).name,
        headline: notice.headline,
        add: notice.add,
        delete: notice.delete,
        status: line ? line.check : 'pending',
      };
    }),
    feed: state.feed,
    runs: RUNS.map(summarizeRun),
  };
}

async function runRebalance(data = {}) {
  const requestId = uuidv4();
  const startedAt = Date.now();
  const cal = calendar();
  const generation = state.generation;
  const run = {
    runId: `RBL-${cal.effectiveDate.replace(/-/g, '')}-${pad(state.nextSeq)}`,
    effectiveDate: cal.effectiveDate,
    status: 'running',
    notices: NOTICES.length,
    releasedAt: null,
    failedStage: null,
    error: null,
  };
  state.nextSeq += 1;
  let stage = null;
  let failedLine = null;
  const lines = [];

  logger.info('Pre-open rebalance started', {
    requestId, runId: run.runId, effectiveDate: cal.effectiveDate, notices: NOTICES.map((n) => n.noticeId), service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 600 + Math.random() * 300));
    if (generation !== state.generation) {
      return { success: false, discarded: true, runId: run.runId, requestId };
    }

    stage = 'ingest';
    const notices = NOTICES.slice();
    stage = 'resolve';
    const resolved = notices.map((notice) => ({ notice, security: resolveSecurity(notice.add.ticker) }));
    stage = 'calculate';
    resolved.forEach(({ notice, security }) => lines.push(buildLine(notice, security)));
    stage = 'build';
    state.feed = { fileId: `PROFORMA-${cal.effectiveDate.replace(/-/g, '')}-${pad(state.nextSeq - 1)}`, status: 'built', lines };
    stage = 'reconcile';
    lines.forEach((line) => {
      failedLine = line;
      reconcile(line);
    });
    failedLine = null;
    stage = 'release';
    state.feed.status = 'released';

    const releasedAt = `${new Date().toLocaleTimeString('en-US', { hour12: false, timeZone: 'America/New_York' })} ET`;
    run.status = 'released';
    run.releasedAt = releasedAt;
    RUNS.unshift(run);
    state.status = 'released';
    state.lastError = null;
    incrementMetric('index_rebalance.release.success', { route: ROUTE });
    recordTiming('index_rebalance.release.latency', Date.now() - startedAt, { route: ROUTE });
    logger.info('Pre-open client feed released', { requestId, runId: run.runId, fileId: state.feed.fileId, service: SERVICE });
    return {
      success: true, requestId, runId: run.runId, fileId: state.feed.fileId, lines, recipients: CHANNELS.reduce((s, c) => s + c.recipients, 0),
    };
  } catch (error) {
    run.status = 'held';
    run.failedStage = stage;
    run.error = { type: error.name, message: error.message };
    RUNS.unshift(run);
    if (state.feed) state.feed.status = 'held';
    state.status = 'held';
    state.lastError = {
      type: error.name,
      message: error.message,
      stage: stageName(stage),
      noticeId: failedLine ? failedLine.noticeId : null,
      ticker: failedLine ? failedLine.ticker : null,
      runId: run.runId,
      requestId,
      at: new Date().toISOString(),
    };

    logger.error('Pre-open rebalance held', {
      requestId, runId: run.runId, stage, noticeId: state.lastError.noticeId, error: error.message, errorType: error.name, stack: error.stack, service: SERVICE,
    });
    incrementMetric('index_rebalance.reconciliation.mismatch', { route: ROUTE, stage: stage || 'unknown', error_type: error.name });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, stage: stage || 'unknown', notice: state.lastError.noticeId || 'n/a', alert_path: 'instant',
      },
      extra: { requestId, runId: run.runId, effectiveDate: cal.effectiveDate, line: failedLine },
    });

    if (!data.synthetic) {
      createSessionAndAlert({
        customer: CUSTOMER,
        issueTitle: `${error.name}: ${error.message}`,
        issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?query=${encodeURIComponent(requestId)}`,
        culprit: 'app/services/verticals/b539e9d4.js — runRebalance',
        errorType: error.name,
        errorValue: error.message,
        devinUserId: data.devinUserId,
        devinEmail: data.devinEmail,
        devinOrgId: data.devinOrgId,
        service: SERVICE,
        verticalLabel: 'S&P Dow Jones Indices — Pre-open Index Rebalance',
        tags: [
          { key: 'route', value: ROUTE },
          { key: 'stage', value: stage || 'unknown' },
          { key: 'notice', value: state.lastError.noticeId || 'n/a' },
          { key: 'effective_date', value: cal.effectiveDate },
        ],
        extra: {
          requestId,
          runId: run.runId,
          effectiveDate: cal.effectiveDate,
          marketOpenAt: cal.marketOpenAt,
          feedDeadline: FEED_DEADLINE,
          feedStatus: 'held',
          recipientsAwaiting: CHANNELS.reduce((sum, channel) => sum + channel.recipients, 0),
          line: failedLine,
        },
        promptAppendix: PROMPT_APPENDIX,
        level: 'error',
        platform: 'node',
        firstSeen: '',
        lastSeen: new Date().toISOString(),
        count: '',
        shortId: '',
        project: 'event-driven-devin',
        release: process.env.SENTRY_RELEASE || 'b539e9d4@1.0.0',
        environment: process.env.DD_ENV || 'prod',
        triggeredRule: 'index_rebalance.reconciliation.mismatch > 0',
      }).catch((err) => {
        logger.error('Failed to trigger Devin session', { error: err.message, requestId, service: SERVICE });
      });
    }

    throw error;
  }
}

const PROMPT_APPENDIX = [
  '*Index rebalance incident.* An announced S&P 500 constituent change must be correct in the pre-open client feed before the 09:30 ET open on the effective date. ETF issuers rebalance from this file.',
  '1. Reproduce first: add a failing Jest test in `tests/b539e9d4-index-rebalance.test.js` that runs the rebalance and asserts the notice SPX-26-117 pro-forma line carries the announced CUSIP and weight.',
  '2. Trace the mismatch from the reconciliation failure to its root cause in the code and fix it there. Every other announced change must still process.',
  '3. Update any test that pinned the old behaviour; run `npx jest tests/b539e9d4-index-rebalance.test.js` and `npm run lint`.',
  '4. Open a PR with the root cause, the reproducing test, the before/after pro-forma line and the time remaining to the open.',
  '5. Post a short summary (root cause, PR link, test result) in this incident\'s Slack thread and ask the index operations on-call to approve. Do not merge; a human approves.',
].join('\n');

function resetRebalance() {
  seedState();
  logger.info('Index rebalance demo reset', { service: SERVICE });
  return { success: true, overview: getOverview() };
}

module.exports = {
  CUSTOMER, NOTICES, INDICES, STAGES, PROMPT_APPENDIX, runRebalance, resetRebalance, getOverview, calendar,
};
