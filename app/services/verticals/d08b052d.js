const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * ComEd My Account app (github.com/Custom-Devin-Demos/exelon-utility-demo-app).
 *
 * The customer surface is a Flutter codebase that ships three ways: the
 * comed.com My Account desktop site (hosted web build at /d08b052d/app), and
 * the ComEd mobile app for Android and iOS. The client builds outage tickets
 * on-device, reports failures to its own Sentry project, and also POSTs them
 * to /api/d08b052d/mobile/error so the Slack alert + Devin session are raised
 * under the app identity without a Sentry webhook round-trip.
 */
const CUSTOMER = 'd08b052d';
const APP_SERVICE = `customer-${CUSTOMER}-mobile`;
const APP_PROJECT = 'comed-account';
const APP_RELEASE = 'comed-account@1.0.0';
const APP_SOURCE_PREFIX = 'comed-account/';
const APP_REPO = 'github.com/Custom-Devin-Demos/exelon-utility-demo-app';
const APP_WEB_PATH = '/d08b052d/app';
const SCENARIO = 'report-outage-dispatch';

/**
 * Scenario directive appended to the Devin investigation prompt. The alert
 * pipeline passes only a prompt to the Devin API, so the repository to
 * remediate and the surfaces to verify have to be named explicitly here.
 */
const APP_REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${APP_REPO}\` (Flutter)`,
  '',
  'This error was raised by the ComEd My Account app, a Flutter codebase that ships as the',
  'comed.com My Account desktop website (web) and as the ComEd mobile app on Android and iOS,',
  'from one commit. Read `AGENTS.md` in that repo first.',
  '',
  'The failing code path is Report Outage:',
  '- Meter registry: `lib/domain/meter_types.dart` (`MeterType.all`, every meter type a premise can carry)',
  '- Fixture: `lib/data/fixtures/customer.dart` (synthetic customer premises and their `meterType`)',
  '- Dispatch registry: `lib/domain/outage_dispatch.dart` (`dispatchRules`, crew + ETR rule per meter type)',
  '- Crash site: `lib/domain/outage_report.dart` (`buildOutageTicket` -> `buildDispatchPlan`)',
  '- Entry: `lib/features/outage/outage_provider.dart` (`ReportOutageFlow.run`) <- `lib/features/outage/report_outage_screen.dart`',
  '',
  `The alert came from the hosted web build at \`https://devindemos.com${APP_WEB_PATH}\` (served from`,
  '`app/public/verticals/d08b052d-app/` in `Custom-Devin-Demos/event-driven-devin`). The same commit',
  'ships natively, so the fix must be verified on web AND on Android AND on iOS.',
  '',
  'Steps:',
  '1. Reproduce on web first: run the Flutter repo `main` in Chrome (`flutter run -d chrome`, or',
  '   `flutter build web` served locally) at desktop width, sign in, click Report Outage on the Home',
  '   premise (1842 N Damen Ave, next-generation smart meter), keep the defaults and submit — confirm',
  '   the "We couldn\'t submit your outage report" card and the incident toast. Note that `flutter test`',
  '   is GREEN on the broken baseline: nothing asserts that every meter type a premise can carry has a',
  '   dispatch rule.',
  '2. Fix the data, not just the crash site: register the missing meter type in `dispatchRules` with',
  '   an accurate rule and make `buildDispatchPlan` tolerate an unregistered meter type (documented',
  '   default or `OutageValidationException`) instead of null-asserting it.',
  '3. Add the prevention control: a `test/domain/outage_dispatch_test.dart` test asserting every',
  '   `MeterType.all` value (and every `demoCustomer` premise meter type) has a `dispatchRules` entry,',
  '   a `buildOutageTicket` test for the next-generation smart meter premise, and coverage for the',
  '   tolerant path. `flutter analyze --fatal-infos` and `flutter test` must pass.',
  `   Do not change \`AppConfig.serviceName\` (\`${APP_SERVICE}\`), \`DevinIdentity\`, or the telemetry tag set.`,
  '4. Re-run the web reproduction on the fix commit and confirm the "Outage reported" confirmation for',
  '   the Home premise, on both the desktop layout and a phone-width viewport.',
  '5. Open a pull request against `main`, request Devin Review, and STOP for human approval.',
  '6. After approval, spawn SEPARATE child sessions for Android (Linux VM with an emulator) and iOS',
  '   (macOS VM with the Xcode simulator). Each checks out the same fix commit SHA, runs',
  '   `scripts/verify-native.sh android` / `scripts/verify-native.sh ios` with `RECORD=1` (build +',
  '   `integration_test/report_outage_test.dart` driving the real mobile UI), and posts the recording',
  '   showing the outage confirmation plus the verified commit SHA to the PR.',
  '7. Confirm web, Android and iOS all verified the SAME commit SHA before merge.',
  `8. Refresh the hosted web build: \`flutter build web --release --base-href ${APP_WEB_PATH}/\` on the`,
  '   fix commit, copy `build/web/` into `app/public/verticals/d08b052d-app/` in',
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

/** True when a request body comes from the ComEd client (any platform). */
function isAppSource(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return source.startsWith(APP_SOURCE_PREFIX);
}

/** True when a request body carries the ComEd app identity. */
function isAppReport(body) {
  return isAppSource(body) && body.service === APP_SERVICE;
}

/**
 * Resolve the reporting user inside the Exelon org from the email the hub
 * (or the native sign-in) supplied, when the client could not supply a user id
 * itself. Returns '' when nobody matches so the caller falls back to the
 * customer config. The lookup authenticates with the Exelon service key:
 * the default enterprise key is not a member of the Exelon org and the
 * members endpoint rejects it.
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
    logger.warn('ComEd app reporter email not found in org', { orgId });
  } catch (err) {
    logger.warn('ComEd app reporter lookup failed', { error: err.message, orgId });
  }
  return '';
}

/**
 * Bridge a failure reported by the ComEd Flutter client (web, Android or iOS)
 * into the Slack alert + Devin session flow under the app identity. The client
 * has already rendered its error message; this is telemetry only.
 */
function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'web', 32);
  const screen = clip(report.screen || 'report_outage', 64);
  const action = clip(report.action || 'report_outage', 64);
  const servicePoint = clip(report.servicePoint || 'unknown', 64);
  const meterType = clip(report.meterType || 'unknown', 32);
  const meterId = clip(report.meterId || 'unknown', 64);
  const outageType = clip(report.outageType || 'unknown', 32);
  const zip = clip(report.zip || 'unknown', 16);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Report Outage failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const outageReport = sanitizeReport(report.report);

  const tags = {
    route: '/api/d08b052d/mobile/error',
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    service_point: servicePoint,
    meter_type: meterType,
    meter_id: meterId,
    outage_type: outageType,
    zip,
    scenario: SCENARIO,
  };

  incrementMetric('report_outage.failure', {
    route: '/api/d08b052d/mobile/error',
    errorClass: errorType,
    platform,
    meterType,
    outageType,
  });

  logger.error('ComEd app reported a failure', {
    reference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    servicePoint,
    meterType,
    meterId,
    outageType,
    errorClass: errorType,
    error: errorMessage,
    sentryEventId: report.sentryEventId || null,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  Sentry.captureException(error, {
    tags,
    extra: { reference, release, environment, report: outageReport, sentryEventId: report.sentryEventId },
  });

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=is%3Aunresolved`,
    culprit: 'lib/domain/outage_report.dart \u2014 buildDispatchPlan',
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail: report.devinEmail,
    devinOrgId: report.devinOrgId,
    service: APP_SERVICE,
    verticalLabel: 'ComEd',
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference,
      stackTrace,
      sentryEventId: report.sentryEventId || null,
      report: outageReport,
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
    logger.error('Failed to create Devin session for ComEd app failure report', {
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
function registerOutage(ticket) {
  const ticketNumber = clip(ticket.ticketNumber, 64) || uuidv4();
  incrementMetric('report_outage.success', {
    route: '/api/d08b052d/outages',
    platform: clip(String(ticket.source || '').replace(APP_SOURCE_PREFIX, ''), 32) || 'web',
    meterType: clip(ticket.meterType || 'unknown', 32),
    outageType: clip(ticket.outageType || 'unknown', 32),
  });
  logger.info('ComEd outage ticket synced', {
    ticketNumber,
    service: APP_SERVICE,
    servicePoint: ticket.servicePoint,
    meterType: ticket.meterType,
    outageType: ticket.outageType,
    crewType: ticket.crewType,
    estimatedRestoration: ticket.estimatedRestoration,
  });
  return {
    success: true,
    ticketNumber,
    status: 'synced',
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
  registerOutage,
};
