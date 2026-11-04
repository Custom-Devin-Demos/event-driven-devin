const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER = '6571dc84';
const APP_SERVICE = 'customer-amadeus-cytric';
const APP_PROJECT = 'amadeus-cytric';
const APP_VERSION = '26.11.2';
const APP_SOURCE_PREFIX = 'amadeus-cytric/';
const APP_PLATFORMS = ['web', 'ios', 'android'];
const PLATFORM_LABELS = { web: 'web', ios: 'iOS', android: 'Android' };
const IOS_ERROR_PATH = '/api/amadeus/cytric/error';
const APP_SCENARIO = 'booking-retrieval-traveler-verification';
const ERROR_CODE = 'CYT-TRP-4031';
const BACKEND_CODE = 'TRAVELER_VERIFICATION_REQUIRED';
// Where the fix lands: the three joao-cognition demo repos (backend + web, Android, iOS).
// The lead follows the cross-platform-incident-fix skill kept in the backend repo.
const BACKEND_REPO = 'joao-cognition/demo_webapp';
const WEB_REPO = 'joao-cognition/demo_webapp';
const ANDROID_REPO = 'joao-cognition/demo_android';
const IOS_REPO = 'joao-cognition/demo_ios';
const SKILL_PATH = '.agents/skills/cross-platform-incident-fix/SKILL.md';
const APP_CULPRIT = 'backend/traveler-verification.js — assertTravelerVerified (403 TRAVELER_VERIFICATION_REQUIRED not handled by the cytric clients)';
// The lead only diagnoses and delegates: the iOS child needs Xcode + the iOS Simulator (macOS),
// the Android child needs the Android SDK + emulator (Linux) and the web child needs Node + a browser (Linux).
const CYTRIC_SESSION_PLATFORM = process.env.CYTRIC_SESSION_PLATFORM === undefined
  ? 'linux'
  : process.env.CYTRIC_SESSION_PLATFORM;
const CYTRIC_SLACK_MEMBER_ID = process.env.CYTRIC_SLACK_MEMBER_ID || '';

const APP_REMEDIATION_DIRECTIVE = `*Repositories:* \`github.com/${BACKEND_REPO}\` (Node backend: airline booking retrieval API + cytric web, React/Next.js), \`github.com/${ANDROID_REPO}\` (Kotlin / Jetpack Compose, \`CytricApp/\`) and \`github.com/${IOS_REPO}\` (Swift / SwiftUI, \`CytricApp/\`)

This alert came from Amadeus cytric, the corporate travel & expense app (synthetic demo estate, not Amadeus or airline data).
A traveler opened *My trips -> TR-48213 (Claire Martin, London -> Nice) -> Boarding pass* and saw "We couldn't open your booking"
with \`${ERROR_CODE}\`. The client asked the airline booking retrieval API for record locator 6KQ2RT and received
\`403 ${BACKEND_CODE}\` (backend request ID in this report).

You are the LEAD Devin. Run the skill *cross-platform-incident-fix* (\`${SKILL_PATH}\` in \`${BACKEND_REPO}\`, Amadeus cytric
scenario) end to end; it overrides this session's playbook. Read \`AGENTS.md\`, \`docs/SHARED-BACKEND-DEMO.md\` and
\`docs/QA-HANDOFF.md\` in that repo first. Do not clone, change or open PRs in \`COG-GTM/event-driven-devin\`,
\`COG-GTM/event-driven-ios\` or \`COG-GTM/android-demos\`, even though this hosted page and the native twin live there.
1. ROOT CAUSE IN THE BACKEND (\`${BACKEND_REPO}\`, isolated run with AMADEUS_ENABLE_INCIDENTS=0): reproduce the retrieval, find the
   release that introduced \`403 ${BACKEND_CODE}\` (\`backend/traveler-verification.js\`, security control SEC-2041: six-character
   record locators are enumerable, so a locator-only retrieval leaks itineraries, names and e-ticket numbers), capture the contract
   with \`npm run parity:contract\`. The control is right. Never roll it back, weaken it, lengthen token lifetimes or verify server-side.
2. SHORT RCA to the user (3 sentences + the BEFORE/AFTER diagram), then
3. THREE child Devin sessions IN PARALLEL, one per client, each on its own machine, all pinned to the same backend SHA:
   - a *macOS* child for \`${IOS_REPO}\` (\`CytricApp/\`): Xcode + iOS Simulator, \`swift test --package-path CytricApp/CytricKit\`,
     run with CYTRIC_API_BASE_URL=http://127.0.0.1:3001 CYTRIC_DISABLE_FAILURE_REPORTS=1.
   - a *Linux* child for \`${ANDROID_REPO}\` (\`CytricApp/\`): Android SDK + emulator, \`./gradlew testDebugUnitTest assembleDebug -PcytricApiBaseUrl=http://10.0.2.2:3001\`.
   - a *Linux* child for \`${WEB_REPO}\` (\`web/\` only, never \`backend/\`): \`npm run build:web\`, \`CYTRIC_EXPECT_BOOKING=failure|success npm run qa:web\`.
   Each child adds the *Verify traveler* step (airline, record locator, surname field, *Verify and continue* resubmitting the identical
   request with travelerLastName + verificationToken, *Cancel* sending nothing, TRAVELER_VERIFICATION_FAILED inline), renders the boarding
   pass, adds tests, keeps the client identity (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}<web|ios|android>\`, \`POST ${IOS_ERROR_PATH}\`)
   unchanged, records BASE (red) then FIX (green) on its real browser / emulator / simulator and returns parity rows P1-P5.
4. PARITY REPORT (scenario x surface, SHAs, evidence) posted on all three PRs, then the clean HTML fix report; Devin Review on each PR,
   owning child fixes findings. Then request human review and stop.
Never merge, deploy, fire incidents or post to Slack/Teams. The hosted page keeps the planted client behaviour so the demo can be re-run.

Reproduction safety: every failure report raises a real Slack alert and Devin session. Always open the hosted page with
\`?reports=off\` and run the native apps with CYTRIC_DISABLE_FAILURE_REPORTS=1 during QA.`;

function clip(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function platformOf(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  if (!source.startsWith(APP_SOURCE_PREFIX)) return '';
  const platform = source.slice(APP_SOURCE_PREFIX.length);
  return APP_PLATFORMS.includes(platform) ? platform : '';
}

// Stale native builds still post the retired approval-failure payload (CYT-APR-4221); only the
// booking-retrieval rejection from the airline API is an incident entry point.
function isAppReport(body) {
  return Boolean(platformOf(body)) && body.service === APP_SERVICE && body.backendCode === BACKEND_CODE;
}

function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = platformOf(report) || 'unknown';
  const screen = clip(report.screen || 'trip', 64);
  const action = clip(report.action || 'open_boarding_pass', 64);
  const backendCode = clip(report.backendCode || BACKEND_CODE, 64);
  const backendRequestId = clip(report.backendRequestId || 'unknown', 64);
  const recordLocator = clip(report.recordLocator || 'unknown', 8);
  const tripId = clip(report.tripId || 'unknown', 16);
  const airline = clip(report.airline || 'unknown', 64);
  const errorCode = clip(report.errorCode || ERROR_CODE, 32);
  const device = clip(report.device || (platform === 'web' ? 'web' : platform === 'ios' ? 'iPhone' : 'Android'), 64);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion || APP_VERSION, 32);
  const errorType = clip(report.errorType || 'BookingRetrievalRejected', 128);
  const errorMessage = clip(report.errorMessage || `${ERROR_CODE}: airline booking retrieval rejected (${backendCode})`, 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || `amadeus-cytric-${platform}@${APP_VERSION}`, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  // Traveler names and surnames never leave the client; only locator/trip identifiers are kept.
  const details = {
    platform, screen, action, backendCode, backendRequestId, recordLocator, tripId, airline, errorCode, device, osVersion, appVersion,
    control: 'SEC-2041 booking retrieval hardening',
  };
  const tags = {
    route: IOS_ERROR_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    backend_code: backendCode,
    error_code: errorCode,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('amadeus_cytric.booking_retrieval.failure', {
    route: IOS_ERROR_PATH, errorClass: errorType, platform, screen, action, backendCode,
  });

  logger.error('Amadeus cytric client reported a booking retrieval failure', {
    reference, service: APP_SERVICE, ...details, errorClass: errorType, error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  error.stack = `${errorType}: ${errorMessage}\n    at BookingService.retrieve (${APP_SOURCE_PREFIX}${platform}/${screen}/${action}:1:1)`;

  Sentry.withScope((scope) => {
    scope.setTransactionName(`${APP_SOURCE_PREFIX}${platform} ${screen} ${action}`);
    scope.addEventProcessor((event) => ({ ...event, release, environment }));
    Sentry.captureException(error, {
      tags,
      extra: {
        reference, release, environment, ...details, errorType, errorMessage, stackTrace,
      },
    });
  });

  const sessionPromise = Promise.resolve(createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(`is:unresolved error_code:${errorCode}`)}`,
    culprit: APP_CULPRIT,
    errorType,
    errorValue: errorMessage,
    devinUserId: report.devinUserId || undefined,
    devinEmail: report.devinEmail,
    devinOrgId: report.devinOrgId || undefined,
    slackMemberId: report.devinEmail ? '' : CYTRIC_SLACK_MEMBER_ID,
    slackMemberIdFallback: CYTRIC_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: `Amadeus cytric — Boarding pass / booking retrieval (${PLATFORM_LABELS[platform] || 'web'})`,
    customer: CUSTOMER,
    project: APP_PROJECT,
    release,
    title: `[Amadeus cytric] ${errorCode} Boarding pass failed: airline API ${backendCode} (${platform})`,
    sessionPlatform: CYTRIC_SESSION_PLATFORM || undefined,
    repos: [BACKEND_REPO, ANDROID_REPO, IOS_REPO],
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    skipVulnerablePr: true,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference, ...details, stackTrace, reporterEmail: clip(report.devinEmail, 128),
    },
    level: 'error',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    environment,
    triggeredRule: '',
  })).catch((alertError) => {
    logger.error('Failed to create Devin session for Amadeus cytric failure report', {
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
  APP_VERSION,
  APP_SOURCE_PREFIX,
  IOS_ERROR_PATH,
  APP_SCENARIO,
  APP_CULPRIT,
  ERROR_CODE,
  BACKEND_CODE,
  BACKEND_REPO,
  IOS_REPO,
  ANDROID_REPO,
  WEB_REPO,
  SKILL_PATH,
  CYTRIC_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  platformOf,
  isAppReport,
  reportAppFailure,
};
