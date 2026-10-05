const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

const CUSTOMER = 'ios-demos';
const APP_SERVICE = 'customer-ios-demo';
const APP_PROJECT = 'ios-event-demos';
const APP_REPO = 'github.com/COG-GTM/event-driven-demos-ios';
const SLUG_PATTERN = /^[0-9a-f]{8}$/;
const IOS_ERROR_PATH = '/api/ios/:slug/error';
const IOS_DEMOS_SLACK_MEMBER_ID = process.env.IOS_DEMOS_SLACK_MEMBER_ID || '';
const IOS_DEMOS_SESSION_PLATFORM = process.env.IOS_DEMOS_SESSION_PLATFORM === undefined
  ? 'macos'
  : process.env.IOS_DEMOS_SESSION_PLATFORM;

function sourceFor(slug) {
  return `ios-demos/${slug}/ios`;
}

function buildRemediationDirective(slug) {
  const appDir = `apps/${slug}`;
  return `*Repository to investigate and fix:* \`${APP_REPO}\` (Swift / SwiftUI, native iOS), folder \`${appDir}/\` only

This alert came from iOS demo app \`${slug}\` in \`COG-GTM/event-driven-demos-ios\`. Investigate and fix that Swift
repository only: not this Node repository. Work only inside \`${appDir}/\`; never edit \`apps/_template/\` or another
app's folder. Read the repo's \`AGENTS.md\`, then \`${appDir}/DEMO.md\` (the customer flow, tap path, reset and
run commands, and which files you may touch). DEMO.md describes the symptom, not the cause: diagnose it yourself.

Steps:
1. This session is requested on macOS. Confirm with \`uname -s\` and \`xcodebuild -version\`: on macOS, do all the
   work here and do not create child sessions; only if this session is not on macOS (platform fallback), create one
   macOS child session for the simulator work.
2. Reproduce on the iOS simulator with \`make run APP=${slug}\` (failure reports stay off) by following the tap path
   in DEMO.md, and confirm the reported error.
3. Fix the root cause in the app's core package; do not swallow the error, skip the failing item or hide the
   error state.
4. Add a regression test that fails before and passes after, and run \`make test APP=${slug}\`.
5. Keep the client identity (\`ios-demos/${slug}/ios\`, \`${APP_SERVICE}\`, \`POST /api/ios/${slug}/error\`) and the
   report payload shape unchanged. Re-run the simulator repro on the fix commit and record BEFORE/AFTER.
6. Open a **draft** PR against \`main\` of \`COG-GTM/event-driven-demos-ios\` titled with a \`[DEMO — DO NOT MERGE]\`
   prefix, request Devin Review, post findings back to the Slack thread, and never merge it: the planted defect on
   \`main\` is kept for future demos.

Reproduction safety: every failure report raises a real Slack alert and Devin session. Never run \`make demo\` and
never launch the app with \`-demoReports on\`; \`make run\` and \`make test\` keep reports off.`;
}

// For the Sentry webhook identity (no slug available statically).
const WEBHOOK_REMEDIATION_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\` (Swift / SwiftUI, native iOS)

This alert came from an iOS demo app in \`COG-GTM/event-driven-demos-ios\`; the app's folder is \`apps/<slug>/\`
where \`<slug>\` is the \`demo_slug\` tag. Follow that folder's \`DEMO.md\` and the repo's \`AGENTS.md\`, run on macOS
(confirm with \`uname -s\`; create one macOS child session only if this session is not on macOS), keep failure
reports off, fix the root cause with a regression test, and open a draft \`[DEMO — DO NOT MERGE]\` PR that is never
merged.`;

function clip(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function sanitizeContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => typeof entry === 'string' || typeof entry === 'number')
    .slice(0, 12)
    .map(([key, entry]) => [
      clip(key, 40),
      typeof entry === 'string' ? clip(entry, 256) : entry,
    ]));
}

function isAppReport(slug, body) {
  return Boolean(
    body
    && SLUG_PATTERN.test(slug)
    && body.source === sourceFor(slug)
    && body.service === APP_SERVICE,
  );
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
    logger.warn('iOS demo reporter email not found in org', { orgId });
  } catch (error) {
    logger.warn('iOS demo reporter lookup failed', { error: error.message, orgId });
  }
  return '';
}

function reportAppFailure(slug, report) {
  const body = report && typeof report === 'object' ? report : {};
  const reference = uuidv4();
  const route = `/api/ios/${slug}/error`;
  const platform = clip(body.platform || 'ios', 32);
  const screen = clip(body.screen || 'unknown', 64);
  const action = clip(body.action || 'unknown', 64);
  const device = clip(body.device, 64);
  const osVersion = clip(body.osVersion, 64);
  const appVersion = clip(body.appVersion, 32);
  const appName = clip(body.appName, 64);
  const errorType = clip(body.errorType || 'Error', 128);
  const errorMessage = clip(body.errorMessage || 'iOS demo failure', 512);
  const stackTrace = clip(body.stackTrace, 4000);
  const environment = clip(body.environment || process.env.DD_ENV || 'prod', 32);
  const sentryEventId = clip(body.sentryEventId, 128);
  const release = clip(body.release || `ios-demo-${slug}@1.0.0`, 64);
  const context = sanitizeContext(body.context);
  const tags = {
    route,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    demo_slug: slug,
    platform,
    screen,
    action,
    scenario: `ios-demo-${slug}`,
    alert_path: 'instant',
  };

  incrementMetric('ios_demo.failure', {
    route,
    errorClass: errorType,
    platform,
    screen,
    action,
    demo_slug: slug,
  });

  logger.error('iOS demo app reported a failure', {
    reference,
    service: APP_SERVICE,
    demoSlug: slug,
    platform,
    screen,
    action,
    device,
    osVersion,
    appVersion,
    errorClass: errorType,
    error: errorMessage,
    sentryEventId: sentryEventId || null,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  error.stack = `${errorType}: ${errorMessage}\n    at ${screen}.${action} (ios-demos/${slug}/ios/${screen}/${action}.swift:1:1)`;

  const extra = {
    reference,
    release,
    environment,
    platform,
    screen,
    action,
    device,
    osVersion,
    appVersion,
    appName: appName || undefined,
    errorType,
    errorMessage,
    stackTrace,
    sentryEventId: sentryEventId || null,
  };
  if (context !== undefined) extra.context = context;

  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST ${route}`);
    Sentry.captureException(error, { tags, extra });
  });

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(`is:unresolved demo_slug:${slug}`)}`,
    culprit: `ios-demos/${slug}/ios ${screen} ${action}`,
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail: body.devinEmail,
    devinOrgId: body.devinOrgId,
    slackMemberId: body.devinEmail ? '' : IOS_DEMOS_SLACK_MEMBER_ID,
    slackMemberIdFallback: IOS_DEMOS_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: appName ? `${appName} (iOS demo ${slug})` : `iOS demo ${slug}`,
    customer: CUSTOMER,
    project: APP_PROJECT,
    release,
    sessionPlatform: IOS_DEMOS_SESSION_PLATFORM || undefined,
    promptAppendix: buildRemediationDirective(slug),
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference,
      platform,
      screen,
      action,
      device,
      osVersion,
      appVersion,
      appName: appName || undefined,
      errorType,
      stackTrace,
      sentryEventId: sentryEventId || null,
      context,
      reporterEmail: clip(body.devinEmail, 128),
    },
    level: 'error',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    environment,
    triggeredRule: '',
  });

  const needsLookup = !body.devinUserId && body.devinEmail && body.devinOrgId;
  const sessionPromise = (needsLookup
    ? resolveUserIdByEmail(body.devinEmail, body.devinOrgId)
      .then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(body.devinUserId)
  ).catch((alertError) => {
    logger.error('Failed to create Devin session for iOS demo failure report', {
      error: alertError.message,
      reference,
    });
  });

  return { reference, sessionPromise };
}

module.exports = {
  CUSTOMER,
  APP_SERVICE,
  APP_PROJECT,
  APP_REPO,
  SLUG_PATTERN,
  IOS_ERROR_PATH,
  IOS_DEMOS_SESSION_PLATFORM,
  sourceFor,
  isAppReport,
  buildRemediationDirective,
  WEBHOOK_REMEDIATION_DIRECTIVE,
  reportAppFailure,
  resolveUserIdByEmail,
};
