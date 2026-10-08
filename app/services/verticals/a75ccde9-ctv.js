const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { OWNER, resolveUserIdByEmail } = require('./a75ccde9');

// FOX One connected-TV app (COG-GTM/fox-one-ctv) error beacon. The TV app's
// `src/telemetry/beacon.ts` posts uncaught errors here when launched with ?beacon=<this url>.
const CUSTOMER = 'a75ccde9';
const APP_SERVICE = 'customer-a75ccde9-ctv';
const APP_PROJECT = 'event-driven-devin';
const APP_REPO = 'COG-GTM/fox-one-ctv';
const ERROR_PATH = '/api/a75ccde9/ctv/error';
const PLATFORMS = ['web', 'tizen', 'webos', 'vizio', 'xbox'];
const ALERT_COOLDOWN_MS = Number(process.env.A75CCDE9_CTV_ALERT_COOLDOWN_MS) || 60 * 60 * 1000;

let lastAlertAt = 0;

function resetAlertCooldown() {
  lastAlertAt = 0;
}

const APP_REMEDIATION_DIRECTIVE = [
  `*Repository to fix:* \`${APP_REPO}\` (React + TypeScript smart TV app: Tizen, webOS, Vizio, Xbox)`,
  '',
  'This alert came from the FOX One TV app error beacon. Fix it in that repository only, not in this',
  'Node repository. Read its `AGENTS.md` first (platform floor, remote keys, recording rules).',
  '',
  'Steps:',
  '1. Start a screen recording with `recording_start` before touching code. Build and serve the app locally',
  '(`npm ci && npm run build && npm run preview`), then open it in Chromium 64, the TV browser floor, with',
  '`npm run tv` (1920x1080, Tizen user agent). Reproduce the failure from the alert and screenshot it.',
  'Also open the same URL in modern Chrome to show it works there.',
  '2. Never pass `?beacon=` pointing at devindemos.com while reproducing: every report raises a real alert',
  'and starts another Devin session. Leave the beacon unset locally.',
  '3. Fix the root cause so it works on Chromium 64 without dropping the feature. Do not wrap it in a',
  'try/catch that hides the rail.',
  '4. Add a regression test that fails before and passes after, and add a guard so this class of bug is',
  'caught in CI next time (for example a lint or test that rejects runtime APIs newer than Chrome 64).',
  '5. Run `npm run verify`, re-run the Chromium 64 repro on the fix (drive it with remote keys: arrows,',
  'Enter, Escape), annotate the failing and passing passes, then `recording_stop`.',
  `6. Open a PR against \`main\` of \`${APP_REPO}\` with the recording and before/after screenshots,`,
  'post the PR link back to the Slack thread, and stop for review. Do not merge.',
].join('\n');

function clip(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function parseReport(raw) {
  if (raw && typeof raw === 'object' && !Buffer.isBuffer(raw)) return raw;
  const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : raw;
  if (typeof text !== 'string' || !text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (error) {
    return {};
  }
}

function isAppReport(body) {
  return Boolean(
    body
    && typeof body.message === 'string'
    && body.message.length > 0
    && PLATFORMS.includes(body.platform),
  );
}

function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform, 16);
  const message = clip(report.message, 512);
  const errorType = clip((/^(\w*Error)\b/.exec(message) || [])[1] || 'TypeError', 64);
  const stackTrace = clip(report.stack, 4000);
  const userAgent = clip(report.userAgent, 256);
  const chromeMatch = /Chrome\/(\d+)/.exec(userAgent);
  const browser = chromeMatch ? `Chrome ${chromeMatch[1]}` : 'unknown';
  const route = clip(report.route || 'render', 32);
  const release = clip(report.release || 'fox-one-ctv@0.1.0', 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const tags = {
    route: ERROR_PATH,
    service: APP_SERVICE,
    customer: CUSTOMER,
    platform,
    browser,
    app_route: route,
    alert_path: 'instant',
  };

  incrementMetric('fox_one_ctv.client_error', { route: ERROR_PATH, platform, browser, errorClass: errorType });
  logger.error('FOX One TV app reported a client error', {
    reference, service: APP_SERVICE, platform, browser, route, errorClass: errorType, error: message,
  });

  const error = new Error(message);
  error.name = errorType;
  if (stackTrace) error.stack = stackTrace;
  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST ${ERROR_PATH}`);
    Sentry.captureException(error, { tags, extra: { reference, release, environment, userAgent } });
  });

  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
    logger.warn('FOX One TV alert suppressed by cooldown', { reference, msSinceLastAlert: now - lastAlertAt });
    return { reference, sessionPromise: Promise.resolve({ triggered: false, suppressed: true }) };
  }
  lastAlertAt = now;

  const devinEmail = clip(report.devinEmail || OWNER.email, 128);
  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${message} (${platform}, ${browser})`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=${encodeURIComponent(`is:unresolved service:${APP_SERVICE}`)}`,
    culprit: `${APP_REPO} — ${route}`,
    errorType,
    errorValue: message,
    devinUserId,
    devinEmail,
    devinOrgId: report.devinOrgId,
    slackMemberId: OWNER.slackMemberId,
    slackMemberIdFallback: OWNER.slackMemberId,
    service: APP_SERVICE,
    verticalLabel: `FOX One TV (${platform})`,
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: { reference, stackTrace, userAgent, platform, browser },
    level: 'error',
    platform,
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: APP_PROJECT,
    release,
    environment,
    triggeredRule: '',
  });

  const needsLookup = !report.devinUserId && devinEmail && report.devinOrgId;
  const sessionPromise = (needsLookup
    ? resolveUserIdByEmail(devinEmail, report.devinOrgId).then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(report.devinUserId)
  ).catch((alertError) => {
    logger.error('Failed to create Devin session for FOX One TV error', { error: alertError.message, reference });
  });

  return { reference, sessionPromise };
}

module.exports = {
  APP_SERVICE,
  APP_REPO,
  APP_REMEDIATION_DIRECTIVE,
  ERROR_PATH,
  PLATFORMS,
  isAppReport,
  parseReport,
  reportAppFailure,
  resetAlertCooldown,
};
