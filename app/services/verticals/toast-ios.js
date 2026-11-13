const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

const TOAST_SLACK_MEMBER_ID = process.env.TOAST_SLACK_MEMBER_ID || '';
const CUSTOMER = 'ios-demos';
const APP_SERVICE = 'customer-toast-ios';
const APP_PROJECT = 'toast-now-ios';
const APP_RELEASE = 'toast-now-ios@2026.11.0';
const APP_SOURCE_PREFIX = 'toast-now/';
const APP_REPO = 'github.com/COG-GTM/event-driven-ios';
const IOS_ERROR_PATH = '/api/toast/ios/error';
const APP_SCENARIO = 'toast-now-ios-failure';
const APP_SENTRY_ISSUE_QUERY = 'is:unresolved service:customer-toast-ios';
// Fix sessions drive the iOS Simulator, so place them on a macOS VM.
// Set TOAST_IOS_SESSION_PLATFORM to the org's macOS platform label (or '' for the org default).
const TOAST_IOS_SESSION_PLATFORM = process.env.TOAST_IOS_SESSION_PLATFORM === undefined
  ? 'macos'
  : process.env.TOAST_IOS_SESSION_PLATFORM;

const APP_REMEDIATION_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\` (Swift / SwiftUI, native iOS)

This is Toast Now, Toast's manager app (fictional restaurant Toast Trattoria), in \`COG-GTM/event-driven-ios\`,
folders \`ToastNowCore/\` and \`ToastNowMobile/\` only. Do not touch this Node repository's app code or the other
apps in the Swift repository. Read its \`AGENTS.md\` (Toast Now section) and \`ToastNowMobile/README.md\` first;
they document the tap path for each report \`action\` (e.g. \`eightySixItem\`, \`editShift\`).

Client identity: \`${APP_SERVICE}\`, source \`${APP_SOURCE_PREFIX}ios\`, report endpoint \`POST ${IOS_ERROR_PATH}\`.
The report's \`screen\`, \`action\`, \`errorType\`, \`errorCode\`, \`stackTrace\` and optional \`multiplayer\` /
\`labor\` objects are in the alert details above.

Steps:
1. This session is requested on macOS. Confirm with \`uname -s\` and \`xcodebuild -version\`; on macOS do all the work
   here and do not create child sessions. Reproduce with failure reports OFF (\`make run-toast\` sets
   \`TOAST_DISABLE_FAILURE_REPORTS=1\` by default; never pass \`0\`).
   - **If the report has a \`multiplayer\` object** (a multi-device race): boot one simulator per participant using
     DIFFERENT device types (e.g. iPhone 17 Pro, iPhone 17, iPad (A16) — whatever \`xcrun simctl list devicetypes\`
     offers; never two of the same type), install the app on each (\`make run-toast SIM_UDID=<udid>
     TOAST_MANAGER_NAME="<participant>"\`), start the local sync server from \`COG-GTM/event-driven-devin\` isolated
     (\`env -i PATH="$PATH" HOME="$HOME" NODE_ENV=development PORT=3101 DD_TRACE_ENABLED=false node app/server.js\`,
     then \`TOAST_ALERT_BASE_URL=http://127.0.0.1:3101\`), \`POST /api/toast/live/toast-trattoria/reset\`, and
     reproduce the two-manager race exactly as the participants did. Compare \`menuVersionKnown\` vs
     \`menuVersionServer\` in the report.
   - Single-device reports reproduce on one simulator.
2. Fix the root cause in \`ToastNowCore\` (not by hiding the banner, swallowing the error or retrying blindly).
3. Remove the \`XCTExpectFailure\` wrapper from the regression test for this defect, add coverage for the fixed path,
   and verify with \`swift test --package-path ToastNowCore\` and \`make test-toast\`.
4. Keep the client identity and the report payload shape unchanged. Re-run the reproduction on the fix commit;
   for multiplayer reports re-run with at least 3 simulators of different device types side by side and record the
   real desktop (Simulator windows bezel-on, same size, placed side by side) showing the change propagate on every
   device with no error banner.
5. Open a **draft** PR against \`main\` of \`COG-GTM/event-driven-ios\` titled with a \`[DEMO — DO NOT MERGE]\` prefix,
   embed the recording, run Devin Review, post the PR + findings back in this Slack thread, and never merge it:
   the planted defect on \`main\` is kept for future demos.

Reproduction safety: every failure report raises a real Slack alert and Devin session. Always run the app with
\`TOAST_DISABLE_FAILURE_REPORTS=1\` unless the alert chain is intentionally being exercised.`;

function clip(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function isAppSource(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return source.startsWith(APP_SOURCE_PREFIX);
}

function isAppReport(body) {
  return isAppSource(body) && body.service === APP_SERVICE;
}

function sanitizeMultiplayer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const participants = Array.isArray(value.participants)
    ? value.participants.slice(0, 8).map((p) => ({
      managerName: clip(p && p.managerName, 64),
      deviceId: clip(p && p.deviceId, 64),
      device: clip(p && p.device, 64),
    }))
    : [];
  const toInt = (n) => (Number.isFinite(Number(n)) ? Math.trunc(Number(n)) : null);
  return {
    participants,
    menuVersionKnown: toInt(value.menuVersionKnown),
    menuVersionServer: toInt(value.menuVersionServer),
    opId: clip(value.opId, 64),
  };
}

function sanitizeLabor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const out = {};
  for (const [key, raw] of Object.entries(value).slice(0, 20)) {
    if (raw === null || ['string', 'number', 'boolean'].includes(typeof raw)) out[clip(key, 48)] = clip(raw, 256);
  }
  return out;
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
    logger.warn('Toast Now iOS reporter email not found in org', { orgId });
  } catch (error) {
    logger.warn('Toast Now iOS reporter lookup failed', { error: error.message, orgId });
  }
  return '';
}

function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'ios', 32);
  const screen = clip(report.screen || 'unknown', 64);
  const action = clip(report.action || 'unknown', 64);
  const errorCode = clip(report.errorCode || 'unknown', 32);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Toast Now action failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const multiplayer = sanitizeMultiplayer(report.multiplayer);
  const labor = sanitizeLabor(report.labor);
  const details = {
    platform,
    screen,
    action,
    errorCode,
    restaurantGuid: clip(report.restaurantGuid || 'unknown', 64),
    location: clip(report.location || 'unknown', 64),
    managerName: clip(report.managerName || 'unknown', 64),
    deviceId: clip(report.deviceId, 64),
    device: clip(report.device || 'iPhone', 64),
    osVersion: clip(report.osVersion, 64),
    appVersion: clip(report.appVersion, 32),
  };
  if (multiplayer) {
    details.participants = multiplayer.participants
      .map((p) => `${p.managerName} (${p.device})`).join(', ') || 'none';
    details.menuVersionKnown = multiplayer.menuVersionKnown;
    details.menuVersionServer = multiplayer.menuVersionServer;
    details.opId = multiplayer.opId;
  }
  const tags = {
    route: IOS_ERROR_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    error_code: errorCode,
    multiplayer: multiplayer ? 'true' : 'false',
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('toast.ios.failure', {
    route: IOS_ERROR_PATH, errorClass: errorType, platform, screen, action,
  });

  logger.error('Toast Now iOS app reported a failure', {
    reference, service: APP_SERVICE, ...details, errorClass: errorType, error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST ${IOS_ERROR_PATH}`);
    scope.addEventProcessor((event) => ({ ...event, release, environment }));
    Sentry.captureException(error, {
      tags,
      extra: { reference, release, environment, ...details, multiplayer, labor },
    });
  });

  const lookupOrgId = report.devinOrgId || getCustomerConfig(CUSTOMER).devinOrgId || process.env.DEVIN_ORG_ID || '';
  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=${encodeURIComponent(APP_SENTRY_ISSUE_QUERY)}`,
    culprit: `${APP_SOURCE_PREFIX}${platform} ${screen} ${action}`,
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail: report.devinEmail,
    devinOrgId: lookupOrgId || undefined,
    slackMemberId: report.devinEmail ? '' : TOAST_SLACK_MEMBER_ID,
    slackMemberIdFallback: TOAST_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: multiplayer ? 'Toast Now — 86 from anywhere (iOS, multiplayer)' : 'Toast Now (iOS)',
    customer: CUSTOMER,
    project: APP_PROJECT,
    release,
    sessionPlatform: TOAST_IOS_SESSION_PLATFORM || undefined,
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference,
      ...details,
      ...(multiplayer ? { multiplayer: JSON.stringify(multiplayer) } : {}),
      ...(labor ? { labor: JSON.stringify(labor) } : {}),
      stackTrace,
      reporterEmail: clip(report.devinEmail, 128),
    },
    level: 'error',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    environment,
    triggeredRule: '',
  });

  const needsLookup = !report.devinUserId && report.devinEmail && lookupOrgId;
  const sessionPromise = (needsLookup
    ? resolveUserIdByEmail(report.devinEmail, lookupOrgId).then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(report.devinUserId || undefined)
  ).catch((alertError) => {
    logger.error('Failed to create Devin session for Toast Now iOS failure report', {
      error: alertError.message, reference,
    });
  });

  return { reference, sessionPromise };
}

module.exports = {
  CUSTOMER,
  APP_SERVICE,
  APP_PROJECT,
  APP_RELEASE,
  APP_SOURCE_PREFIX,
  APP_REPO,
  IOS_ERROR_PATH,
  APP_SCENARIO,
  TOAST_IOS_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  isAppSource,
  isAppReport,
  reportAppFailure,
  resolveUserIdByEmail,
  sanitizeMultiplayer,
};
