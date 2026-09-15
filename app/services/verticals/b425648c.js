const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * FPL My Account (github.com/Custom-Devin-Demos/fpl-my-account-demo-app).
 *
 * Florida Power & Light — a NextEra Energy company — customer experience as a
 * Flutter codebase that ships three ways: fpl.com My Account on desktop web
 * (hosted web build at /b425648c/app), and the FPL Mobile App on Android and
 * iOS. The client builds outage tickets on-device (validation, service-point
 * lookup, restoration estimate), reports failures to its own Sentry project,
 * and also POSTs them to /api/b425648c/mobile/error so the Slack alert + Devin
 * session are raised under the app identity without a Sentry webhook
 * round-trip.
 */
const CUSTOMER = 'b425648c';
const APP_SERVICE = `customer-${CUSTOMER}-mobile`;
const APP_PROJECT = 'fpl-my-account';
const APP_RELEASE = 'fpl-my-account@1.0.0';
const APP_SOURCE_PREFIX = 'fpl-my-account/';
const APP_REPO = 'github.com/Custom-Devin-Demos/fpl-my-account-demo-app';
const APP_WEB_PATH = '/b425648c/app';
const SCENARIO = 'outage-report-restoration';

/**
 * Scenario directive appended to the Devin investigation prompt. The alert
 * pipeline passes only a prompt to the Devin API, so the repository to
 * remediate and the surfaces to verify have to be named explicitly here.
 */
const APP_REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${APP_REPO}\` (Flutter)`,
  '',
  'This error was raised by the FPL My Account app, a Flutter codebase that ships as the fpl.com',
  'My Account website (desktop web) and as the FPL Mobile App on Android and iOS, from one commit.',
  'Read `AGENTS.md` in that repo first.',
  '',
  'The failing code path is Report an Outage:',
  '- Service points: `lib/domain/accounts.dart` (customer accounts, each with a `circuitType`)',
  '- Circuit registry: `lib/domain/circuits.dart` (`CircuitType` codes and `restorationProfiles`)',
  '- Crash site: `lib/domain/outage_report.dart` (`buildOutageTicket` -> `estimateRestoration`)',
  '- Entry: `lib/features/outages/outage_flow.dart` (`OutageReportFlow.run`) <- `lib/features/outages/report_outage_screen.dart`',
  '',
  `The alert came from the hosted web build at \`https://devindemos.com${APP_WEB_PATH}\` (served from`,
  '`app/public/verticals/b425648c-app/` in `Custom-Devin-Demos/event-driven-devin`). The same commit',
  'ships natively, so the fix must be verified on web AND on Android AND on iOS.',
  '',
  'Steps:',
  '1. Reproduce on web first: run the Flutter repo `main` in Chrome (`flutter run -d chrome`, or',
  '   `flutter build web` served locally) at desktop width, switch the account picker to the Jupiter',
  '   account (0123456798, a Storm Secure Underground service point), click Report an Outage, confirm',
  '   the breakers checkbox and submit — confirm the "We couldn\'t submit your outage report" card and',
  '   the incident toast. Note that `flutter test` is GREEN on the broken baseline: nothing asserts',
  '   that every `CircuitType` a service point can carry has a restoration profile.',
  '2. Fix the data, not just the crash site: register the missing circuit type in',
  '   `restorationProfiles` with an accurate crew and restoration window, and make',
  '   `estimateRestoration` tolerate an unregistered circuit (documented default or',
  '   `OutageValidationException`) instead of null-asserting it.',
  '3. Add the prevention control: a `test/domain/restoration_test.dart` test asserting every',
  '   `CircuitType` value (and every service point\'s `circuitType`) has a `restorationProfiles` entry,',
  '   a `buildOutageTicket` test for a Storm Secure Underground service point, and coverage for the',
  '   tolerant path. `flutter analyze --fatal-infos` and `flutter test` must pass.',
  `   Do not change \`AppConfig.serviceName\` (\`${APP_SERVICE}\`), \`DevinIdentity\`, or the telemetry tag set.`,
  '4. Re-run the web reproduction on the fix commit and confirm the outage ticket with its estimated',
  '   restoration window for the Jupiter account, on both the desktop layout and a phone-width viewport.',
  '5. Open a pull request against `main`, request Devin Review, and STOP for human approval.',
  '6. After approval, spawn SEPARATE child sessions for Android (Linux VM with an emulator) and iOS',
  '   (macOS VM with the Xcode simulator). Each checks out the same fix commit SHA, runs',
  '   `scripts/verify-native.sh android` / `scripts/verify-native.sh ios` with `RECORD=1` (build +',
  '   `integration_test/report_outage_test.dart` driving the real mobile UI), and posts the recording',
  '   showing the outage ticket plus the verified commit SHA to the PR.',
  '7. Confirm web, Android and iOS all verified the SAME commit SHA before merge.',
  `8. Refresh the hosted web build: \`flutter build web --release --base-href ${APP_WEB_PATH}/\` on the`,
  '   fix commit, copy `build/web/` into `app/public/verticals/b425648c-app/` in',
  '   `Custom-Devin-Demos/event-driven-devin`, delete the copied `canvaskit/` directory, and open a',
  `   PR there so the deployed site at \`${APP_WEB_PATH}\` picks up the fix.`,
].join('\n');

function clip(value, max) {
  const text = value == null ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** Keep only flat scalar report metadata so Sentry/Slack payloads stay bounded. */
function sanitizeReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return {};
  const out = {};
  for (const [key, value] of Object.entries(report)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[clip(key, 64)] = typeof value === 'string' ? clip(value, 256) : value;
    }
  }
  return out;
}

/** True when a request body comes from the FPL client (any platform). */
function isAppSource(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return source.startsWith(APP_SOURCE_PREFIX);
}

/** True when a request body carries the FPL app identity. */
function isAppReport(body) {
  return isAppSource(body) && body.service === APP_SERVICE;
}

/**
 * Resolve the reporting user inside the NextEra org from the email the hub
 * (or the native sign-in) supplied, when the client could not supply a user id
 * itself. Returns '' when nobody matches so the caller falls back to the
 * customer config. The lookup authenticates with the FPL service key: the
 * default enterprise key is not a member of the NextEra org and the members
 * endpoint rejects it.
 */
async function resolveUserIdByEmail(email, orgId) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !orgId) return '';
  try {
    const { apiKey } = getCustomerConfig(CUSTOMER);
    const auth = apiKey ? { apiKey } : {};
    const members = await listOrgUsers(orgId, auth);
    const member = members.find((u) => (u.email || '').toLowerCase() === normalized);
    if (member) return member.user_id;
    const admins = await listEnterpriseAdmins(auth);
    const admin = admins.find((u) => (u.email || '').toLowerCase() === normalized);
    if (admin) return admin.user_id;
    logger.warn('FPL app reporter email not found in org', { orgId });
  } catch (err) {
    logger.warn('FPL app reporter lookup failed', { error: err.message, orgId });
  }
  return '';
}

/**
 * Bridge a failure reported by the FPL Flutter client (web, Android or iOS)
 * into the Slack alert + Devin session flow under the app identity. The
 * client has already rendered its error card; this is telemetry only.
 */
function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'web', 32);
  const screen = clip(report.screen || 'outage_report', 64);
  const action = clip(report.action || 'submit_outage_report', 64);
  const accountNumber = clip(report.accountNumber || 'unknown', 32);
  const premiseId = clip(report.premiseId || 'unknown', 64);
  const circuitType = clip(report.circuitType || 'unknown', 48);
  const problem = clip(report.problem || 'unknown', 32);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Outage report failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const outageReport = sanitizeReport(report.report);

  const tags = {
    route: '/api/b425648c/mobile/error',
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    account_number: accountNumber,
    premise_id: premiseId,
    circuit_type: circuitType,
    problem,
    scenario: SCENARIO,
  };

  incrementMetric('outage_report.failure', {
    route: '/api/b425648c/mobile/error',
    errorClass: errorType,
    platform,
    circuitType,
    problem,
  });

  logger.error('FPL app reported a failure', {
    reference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    accountNumber,
    premiseId,
    circuitType,
    problem,
    errorClass: errorType,
    error: errorMessage,
    sentryEventId: report.sentryEventId || null,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  Sentry.captureException(error, {
    tags,
    extra: { reference, release, environment, outageReport, sentryEventId: report.sentryEventId },
  });

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=is%3Aunresolved`,
    culprit: 'lib/domain/outage_report.dart \u2014 estimateRestoration',
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail: report.devinEmail,
    devinOrgId: report.devinOrgId,
    service: APP_SERVICE,
    verticalLabel: 'FPL',
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference,
      stackTrace,
      sentryEventId: report.sentryEventId || null,
      outageReport,
    },
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

  const needsLookup = !report.devinUserId && report.devinEmail && report.devinOrgId;
  const sessionPromise = (needsLookup
    ? resolveUserIdByEmail(report.devinEmail, report.devinOrgId)
      .then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(report.devinUserId)
  ).catch((err) => {
    logger.error('Failed to create Devin session for FPL app failure report', {
      error: err.message,
      reference,
    });
  });

  return { reference, sessionPromise };
}

/**
 * Acknowledge an outage ticket the client already built on-device. The client
 * is the system of record for the demo; this is registration only.
 */
function registerOutageReport(ticket) {
  const ticketNumber = clip(ticket.ticketNumber, 32) || `OUT-${uuidv4().slice(0, 8).toUpperCase()}`;
  incrementMetric('outage_report.success', {
    route: '/api/b425648c/outage/report',
    platform: clip(String(ticket.source || '').replace(APP_SOURCE_PREFIX, ''), 32) || 'web',
    circuitType: clip(ticket.circuitType || 'unknown', 48),
    problem: clip(ticket.problem || 'unknown', 32),
  });
  logger.info('FPL outage report registered', {
    ticketNumber,
    service: APP_SERVICE,
    accountNumber: ticket.accountNumber,
    premiseId: ticket.premiseId,
    circuitType: ticket.circuitType,
    problem: ticket.problem,
    crew: ticket.crew,
    windowStart: ticket.windowStart,
    windowEnd: ticket.windowEnd,
    customersAffected: ticket.customersAffected,
  });
  return {
    success: true,
    ticketNumber,
    status: 'received',
    receivedAt: new Date().toISOString(),
  };
}

module.exports = {
  APP_SERVICE,
  APP_PROJECT,
  APP_RELEASE,
  APP_SOURCE_PREFIX,
  APP_REPO,
  APP_WEB_PATH,
  APP_REMEDIATION_DIRECTIVE,
  SCENARIO,
  isAppReport,
  isAppSource,
  reportAppFailure,
  registerOutageReport,
};
