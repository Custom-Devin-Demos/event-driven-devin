const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER = '6571dc84';
const APP_SERVICE = 'customer-amadeus-cytric';
const APP_PROJECT = 'amadeus-cytric';
const APP_VERSION = '22.9.8';
const APP_SOURCE_PREFIX = 'amadeus-cytric/';
const APP_PLATFORMS = ['web', 'ios', 'android'];
const PLATFORM_LABELS = { web: 'web', ios: 'iOS', android: 'Android' };
const IOS_ERROR_PATH = '/api/amadeus/cytric/error';
const APP_SCENARIO = 'trip-approval-premium-economy';
const ERROR_CODE = 'CYT-APR-4221';
const IOS_REPO = 'COG-GTM/event-driven-ios';
const ANDROID_REPO = 'COG-GTM/android-demos';
const ANDROID_APP = 'apps/6571dc84';
const WEB_REPO = 'COG-GTM/event-driven-devin';
const WEB_PAGE = 'app/public/verticals/6571dc84.html';
const WEB_TEST = 'tests/6571dc84-amadeus-cytric.test.js';
const APP_CULPRIT = 'TripApproval.approve(request:) — travel policy cabin rule lookup (CytricCore/TravelPolicy.swift + web replica)';
// The orchestrator only diagnoses and delegates: the iOS child needs Xcode + the
// iOS Simulator (macOS), the Android child needs the Android SDK + emulator
// (Linux) and the web child needs Node + a browser (Linux).
const CYTRIC_SESSION_PLATFORM = process.env.CYTRIC_SESSION_PLATFORM === undefined
  ? 'linux'
  : process.env.CYTRIC_SESSION_PLATFORM;
const CYTRIC_SLACK_MEMBER_ID = process.env.CYTRIC_SLACK_MEMBER_ID || '';

const APP_REMEDIATION_DIRECTIVE = `*Repositories:* \`github.com/${IOS_REPO}\` (Swift / SwiftUI, native iOS), \`github.com/${ANDROID_REPO}\` (Kotlin / Jetpack Compose, native Android) and \`github.com/${WEB_REPO}\` (web replica)

This alert came from Amadeus Cytric Mobile, the corporate travel & expense app. The same Cytric client ships on
three platforms that each carry their own copy of the shared travel policy rules (the cabin rule table used by
*Approve* on a trip request in Tasks):
- iOS: \`${IOS_REPO}\`, folders \`CytricCore/\` (Foundation-only rules, \`TravelPolicy.swift\`) and \`CytricMobile/\` (SwiftUI)
- Android: \`${ANDROID_REPO}\`, \`${ANDROID_APP}/\` (\`core/TravelPolicy.kt\` \`TravelPolicy\`, Compose UI); read its \`DEMO.md\`
- Web: \`${WEB_REPO}\`, \`${WEB_PAGE}\` (the \`TRAVEL_POLICY\` block), served at \`/cytric\`

Failing path on all three: Sign in -> Tasks -> trip request TR-48213 (Claire Martin, London -> Nice, Premium Economy)
-> *Approve* fails with \`${ERROR_CODE}\`. The Madrid trip request (Economy) approves normally.

You are the ORCHESTRATOR for this incident. Do not edit, build or run any app yourself.
1. Diagnose read-only: open the cabin rule lookup in all three clients and state the root cause (why a Premium Economy
   trip request has no policy rule). DEMO docs describe the symptom, not the cause.
2. Because the defect lives in a dependency all three clients carry, create THREE child Devin sessions in parallel and give
   each the diagnosis:
   - a *macOS* child for \`${IOS_REPO}\` (\`CytricCore/\`, \`CytricMobile/\` only): needs Xcode + the iOS Simulator.
     \`swift test --package-path CytricCore\`, \`make test-cytric\`, repro with \`make run-cytric\`
     (sets \`CYTRIC_DISABLE_FAILURE_REPORTS=1\`).
   - a *Linux* child for \`${ANDROID_REPO}\` (\`${ANDROID_APP}/\` only): needs the Android SDK + emulator.
     \`export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64\`, \`make test APP=6571dc84\`, repro with \`make run APP=6571dc84\`
     (reports stay off; never \`make demo\`).
   - a *Linux* child for \`${WEB_REPO}\` (\`${WEB_PAGE}\` and \`${WEB_TEST}\` only): \`npx jest ${WEB_TEST}\`,
     repro in a browser at \`http://localhost:<port>/cytric?reports=off\`.
3. Each child must: reproduce with failure reports off; fix the root cause in its travel policy rules (do not swallow the
   error, change the fare's cabin, auto-reject the request or hide the red error state); add a regression test that fails
   before and passes after; keep the client identity (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}<web|ios|android>\`,
   \`POST ${IOS_ERROR_PATH}\`) and payload shape unchanged; record BEFORE/AFTER; open a *draft* PR against \`main\` titled
   \`[DEMO — DO NOT MERGE] ...\`, and report the PR link and test output.
4. Wait for all three children, review all three PRs (the iOS, Android and web fixes must be equivalent and each must
   carry a regression test), send corrections back to the owning child, then post a summary with all three PR links
   to the Slack thread.
Never merge: \`main\` keeps the planted defect so the demo can be re-run.

Reproduction safety: every failure report raises a real Slack alert and Devin session. Never run the iOS or Android app
with failure reports on, and always open the web page with \`?reports=off\`.`;

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

function isAppReport(body) {
  return Boolean(platformOf(body)) && body.service === APP_SERVICE;
}

function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = platformOf(report) || 'unknown';
  const screen = clip(report.screen || 'TaskDetail', 64);
  const action = clip(report.action || 'approveTripRequest', 64);
  const requestId = clip(report.requestId || 'unknown', 32);
  const tripTitle = clip(report.tripTitle || 'unknown', 128);
  const traveler = clip(report.traveler || 'unknown', 64);
  const cabin = clip(report.cabin || 'unknown', 32);
  const policy = clip(report.policy || 'unknown', 64);
  const approver = clip(report.approver || 'unknown', 64);
  const total = clip(report.total || 'unknown', 32);
  const errorCode = clip(report.errorCode || ERROR_CODE, 32);
  const device = clip(report.device || (platform === 'ios' ? 'iPhone' : 'web'), 64);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion || APP_VERSION, 32);
  const errorType = clip(report.errorType || 'ApprovalError', 128);
  const errorMessage = clip(report.errorMessage || 'Trip approval failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || `amadeus-cytric-${platform}@${APP_VERSION}`, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const details = {
    platform, screen, action, requestId, tripTitle, traveler, cabin, policy, approver, total, errorCode, device, osVersion, appVersion,
  };
  const tags = {
    route: IOS_ERROR_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    cabin,
    error_code: errorCode,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('amadeus_cytric.trip_approval.failure', {
    route: IOS_ERROR_PATH, errorClass: errorType, platform, screen, action, cabin,
  });

  logger.error('Amadeus Cytric app reported a trip approval failure', {
    reference, service: APP_SERVICE, ...details, errorClass: errorType, error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  error.stack = `${errorType}: ${errorMessage}\n    at TripApproval.approve (${APP_SOURCE_PREFIX}${platform}/${screen}/${action}:1:1)`;

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
    verticalLabel: `Amadeus Cytric — Trip request Approve (${PLATFORM_LABELS[platform] || 'web'})`,
    customer: CUSTOMER,
    project: APP_PROJECT,
    release,
    title: `[Amadeus Cytric] ${errorCode} Approve failed for ${cabin} trip request (${platform})`,
    sessionPlatform: CYTRIC_SESSION_PLATFORM || undefined,
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
    logger.error('Failed to create Devin session for Amadeus Cytric failure report', {
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
  IOS_REPO,
  ANDROID_REPO,
  WEB_REPO,
  CYTRIC_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  platformOf,
  isAppReport,
  reportAppFailure,
};
