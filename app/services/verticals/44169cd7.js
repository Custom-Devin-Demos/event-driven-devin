const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');
const PARTITIONS = require('./44169cd7-partitions.json');

const CUSTOMER = '44169cd7';
const ROUTE = '/api/44169cd7/snapshots';
const SERVICE = 'ratings-data-feed';
const RELEASE = 'ratings-data-feed@4.12.0';
const FEED_TIMEZONE = 'America/New_York';
const ALERT_COOLDOWN_MS = Number(process.env.ALERT_COOLDOWN_MS_44169CD7) || 10 * 60 * 1000;
const SLACK_MEMBER_ID_FALLBACK = process.env.RATINGS_FEED_SLACK_MEMBER_ID || '';
// Branch the investigation starts from and targets; override while the skin is unmerged.
const SOURCE_BRANCH = process.env.RATINGS_FEED_SOURCE_BRANCH || 'main';

// Scheduled end-of-day snapshot runs. cutoffUtc is the instant the run closes the
// day's rating actions; cutoffLocal is how operations schedule it (New York time).
const SNAPSHOT_RUNS = [
  {
    runId: 'eod-2026-10-12',
    label: 'Mon 12 Oct 2026, end of day',
    cutoffLocal: '23:30 ET',
    cutoffUtc: '2026-10-13T03:30:00Z',
  },
  {
    runId: 'eod-2026-10-09',
    label: 'Fri 9 Oct 2026, end of day',
    cutoffLocal: '18:00 ET',
    cutoffUtc: '2026-10-09T22:00:00Z',
  },
];

const REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`COG-GTM/event-driven-devin\` (branch \`${SOURCE_BRANCH}\`)`,
  '',
  'The nightly end-of-day ratings snapshot for the Ratings Data Feed failed with HTTP 500, so subscribers did not receive the snapshot for business date 12 Oct 2026.',
  '- Service: `app/services/verticals/44169cd7.js`',
  '- Rating action partitions: `app/services/verticals/44169cd7-partitions.json`',
  '- Route: `app/routes/verticals/44169cd7.js`',
  '- Page: `app/public/verticals/44169cd7.html` (served at `/moodys`)',
  '',
  'Steps:',
  '1. Find the root cause from the code and telemetry. Before changing any code, post a short root cause in the Slack alert thread: two or three plain sentences a non-engineer can follow (what failed, why, and who is affected).',
  '2. Fix the cause, not the crash site. Every scheduled snapshot run on the page must complete, whatever time of night its cut-off falls. Runs that already succeed must produce the same output.',
  '3. Add a regression test under `tests/` for the failing run. Run `npx jest tests/44169cd7-ratings-snapshot.test.js --runInBand` and `npm run lint`.',
  '4. Reproduce and verify on a local server only (`PORT=3100 node app/server.js`, then open `/moodys`): both snapshot runs must complete.',
  `5. Open a pull request against \`${SOURCE_BRANCH}\` whose description ends with \`Devin-Org: engineering\`, post the PR link in the Slack alert thread, and stop for human review. Do not merge.`,
].join('\n');

let lastAlertAt = 0;

function resetAlertCooldown() {
  lastAlertAt = 0;
}

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function findRun(runId) {
  return SNAPSHOT_RUNS.find((run) => run.runId === runId);
}

// The business date a snapshot belongs to: the calendar day of its cut-off.
function resolveBusinessDate(cutoffUtc) {
  return new Date(cutoffUtc).toISOString().slice(0, 10);
}

function buildSnapshot(run) {
  const businessDate = resolveBusinessDate(run.cutoffUtc);
  const partition = PARTITIONS[businessDate];
  const rows = partition.issuers.map((issuer) => ({
    issuerId: issuer.issuerId,
    issuer: issuer.name,
    sector: issuer.sector,
    rating: issuer.rating,
    outlook: issuer.outlook,
    action: issuer.action,
  }));
  const actions = rows.reduce((counts, row) => {
    counts[row.action] = (counts[row.action] || 0) + 1;
    return counts;
  }, {});
  const checksum = crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
  return { businessDate: partition.businessDate, rows, actions, checksum };
}

function feedOverview() {
  const latest = PARTITIONS['2026-10-12'];
  return {
    feed: 'Ratings Data Feed',
    timezone: FEED_TIMEZONE,
    lastSuccessfulSnapshot: { businessDate: '2026-10-09', completedAt: '2026-10-09T22:03:18Z' },
    runs: SNAPSHOT_RUNS.map(({ runId, label, cutoffLocal }) => ({ runId, label, cutoffLocal })),
    ratingActions: { businessDate: latest.businessDate, issuers: latest.issuers },
  };
}

async function resolveUserIdByEmail(email, orgId) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !orgId) return '';
  try {
    const { apiKey } = getCustomerConfig(CUSTOMER);
    const auth = apiKey ? { apiKey } : {};
    const members = await listOrgUsers(orgId, auth);
    const member = members.find((user) => (user.email || '').toLowerCase() === normalized);
    if (member) return member.user_id;
    const admins = await listEnterpriseAdmins(auth);
    const admin = admins.find((user) => (user.email || '').toLowerCase() === normalized);
    if (admin) return admin.user_id;
    logger.warn('Ratings feed reporter email not found in org', { orgId });
  } catch (error) {
    logger.warn('Ratings feed reporter lookup failed', { error: error.message, orgId });
  }
  return '';
}

function raiseAlert(error, run, snapshotId, data) {
  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
    logger.warn('Ratings snapshot alert suppressed by cooldown', {
      snapshotId,
      cooldownMs: ALERT_COOLDOWN_MS,
      msSinceLastAlert: now - lastAlertAt,
    });
    return Promise.resolve({ triggered: false, suppressed: true });
  }
  lastAlertAt = now;

  const tags = [
    { key: 'route', value: ROUTE },
    { key: 'service', value: SERVICE },
    { key: 'job', value: 'eod-ratings-snapshot' },
    { key: 'run_id', value: run.runId },
  ];

  const send = (devinUserId) => createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/44169cd7.js in buildSnapshot',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Ratings Data Feed, nightly snapshot',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    slackMemberIdFallback: SLACK_MEMBER_ID_FALLBACK,
    tags,
    extra: { snapshotId, runId: run.runId, cutoffUtc: run.cutoffUtc },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: RELEASE,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  });

  const needsLookup = !data.devinUserId && data.devinEmail && data.devinOrgId;
  const releaseCooldown = () => {
    if (lastAlertAt === now) lastAlertAt = 0;
  };
  return (needsLookup
    ? resolveUserIdByEmail(data.devinEmail, data.devinOrgId).then((userId) => send(userId || undefined))
    : send(data.devinUserId || undefined)
  ).then((result) => {
    if (!result) releaseCooldown();
    return result;
  }).catch((alertError) => {
    releaseCooldown();
    logger.error('Failed to raise alert for ratings snapshot failure', {
      error: alertError.message,
      snapshotId,
    });
  });
}

async function runSnapshot(data) {
  const run = findRun(data.runId);
  if (!run) {
    throw validationError(`Unknown snapshot run "${data.runId}".`, 'UNKNOWN_RUN');
  }

  const startTime = Date.now();
  const snapshotId = `RDF-${uuidv4().slice(0, 8).toUpperCase()}`;

  logger.info('Running end-of-day ratings snapshot', {
    snapshotId,
    runId: run.runId,
    cutoffUtc: run.cutoffUtc,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 300));
    const snapshot = buildSnapshot(run);
    const duration = Date.now() - startTime;

    incrementMetric('ratings_snapshot.success', { route: ROUTE, run: run.runId });
    recordTiming('ratings_snapshot.latency', duration, { route: ROUTE });

    return {
      success: true,
      snapshotId,
      runId: run.runId,
      businessDate: snapshot.businessDate,
      issuerCount: snapshot.rows.length,
      actions: snapshot.actions,
      checksum: snapshot.checksum,
      completedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('ratings_snapshot.failure', { route: ROUTE, run: run.runId, errorClass: error.name });
    recordTiming('ratings_snapshot.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('End-of-day ratings snapshot failed', {
      snapshotId,
      runId: run.runId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, run_id: run.runId, alert_path: 'instant' },
      extra: { snapshotId, cutoffUtc: run.cutoffUtc },
    });

    raiseAlert(error, run, snapshotId, data);

    error.snapshotId = snapshotId;
    throw error;
  }
}

module.exports = {
  CUSTOMER,
  FEED_TIMEZONE,
  PARTITIONS,
  REMEDIATION_DIRECTIVE,
  ROUTE,
  SERVICE,
  SNAPSHOT_RUNS,
  buildSnapshot,
  feedOverview,
  resetAlertCooldown,
  resolveBusinessDate,
  runSnapshot,
};
