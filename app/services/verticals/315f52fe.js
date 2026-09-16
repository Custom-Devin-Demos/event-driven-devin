const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * NVIDIA GeForce NOW for iOS (github.com/Custom-Devin-Demos/nvidia-geforce-now-demo-app).
 *
 * The product surface is a native SwiftUI app (iOS only — there is no web or
 * Android build and no hosted bundle here). The app schedules a cloud rig for
 * the member's tier on-device; when Play fails it POSTs a `FailureReport` to
 * /api/315f52fe/ios/error so the Slack alert + Devin session are raised under
 * the app identity. The app carries no Sentry SDK, so this route is the only
 * alert path for it: no webhook round-trip, no duplicate to suppress on the
 * client side.
 */
const CUSTOMER = '315f52fe';
const APP_SERVICE = `customer-${CUSTOMER}-ios`;
const APP_PROJECT = 'geforce-now-ios';
const APP_RELEASE = 'geforce-now-ios@1.0.0';
const APP_SOURCE_PREFIX = 'geforce-now-ios/';
const APP_REPO = 'github.com/Custom-Devin-Demos/nvidia-geforce-now-demo-app';
const ERROR_PATH = `/api/${CUSTOMER}/ios/error`;
const SCENARIO = 'play-ultimate-rig-profile';
const CULPRIT = 'Core/Sources/GeForceNowCore/StreamProfiles.swift \u2014 StreamProfileRegistry.profile(for:device:)';

/**
 * Owner of every alert and Devin session this vertical raises. This demo was
 * built for Shawn, so the card @-mentions him and the session is created as
 * him. The email typed at the app's sign-in is synthetic and never redirects
 * ownership: it is kept on the card as context only.
 */
const OWNER = Object.freeze({
  email: 'shawn@cognition.ai',
  slackMemberId: 'U08RSEMUV3L',
  devinUserId: 'google-oauth2|101186599233686760148',
  devinOrgId: 'org-a26acd61afbe4ff3b0c531026e2cbce5',
});

/**
 * Scenario directive appended to the Devin investigation prompt. The alert
 * pipeline passes only a prompt to the Devin API, so the repository to
 * remediate and the surface to verify have to be named explicitly here.
 */
const APP_REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${APP_REPO}\` (Swift / SwiftUI, iOS 17+)`,
  '',
  'This error was raised by the GeForce NOW iOS app, a native SwiftUI codebase. It is iOS only:',
  'there is no web or Android build. Read `AGENTS.md` in that repo first.',
  '',
  'The failing code path is Play (launch a cloud gaming session):',
  '- Tier -> rig: `Core/Sources/GeForceNowCore/RigCatalog.swift` (`RigCatalog.rigClass(for:)`; Ultimate -> `.rtx5080`)',
  '- Registry: `Core/Sources/GeForceNowCore/StreamProfiles.swift` (`StreamProfileRegistry.profiles`, one table per `RigClass`)',
  '- Crash site: `StreamProfileRegistry.profile(for:device:)` throwing `StreamProfileError.unregisteredRig`',
  '- Builder: `Core/Sources/GeForceNowCore/SessionLaunch.swift` (`SessionRequestBuilder.build` -> `LaunchSessionFlow.run`)',
  '- Entry: `App/GeForceNOW/Features/Play/PlayViewModel.swift` (`PlayViewModel.play`) <- `PlayButton`',
  '',
  'Steps:',
  '1. Reproduce on the iOS simulator first (macOS VM with Xcode): `scripts/bootstrap-macos.sh &&',
  '   scripts/verify-ios.sh`, sign in with any email, keep the default Ultimate membership, open a',
  '   game from Home or Games, tap Play now, and confirm the "couldn\'t start your session" card showing',
  '   `StreamProfileError.unregisteredRig`. Switching to Performance under Membership makes the same',
  '   tap succeed. Note that `swift test` in `Core/` is GREEN on the broken baseline: nothing asserts',
  '   that every rig class a tier maps to has a stream profile.',
  '   Run every reproduction with failure reporting OFF (`scripts/verify-ios.sh` does this by default;',
  '   set `GFN_DISABLE_FAILURE_REPORTS=1` in the app\'s environment when launching it any other way).',
  `   A report posted to ${ERROR_PATH} opens another Slack alert and another Devin session; exactly one`,
  '   alert exists per real failure, and the one that started this session is it.',
  '2. Fix the data, not just the crash site: register accurate RTX 5080 (Blackwell) profiles for every',
  '   `DeviceClass` in `StreamProfileRegistry.profiles`, and make `SessionRequestBuilder.build` degrade',
  '   gracefully for an unregistered rig (documented fallback profile or typed error) instead of',
  '   failing the launch. Never `!`-unwrap a registry lookup.',
  '3. Add the prevention control: a test in `Core/Tests/GeForceNowCoreTests/SessionLaunchTests.swift`',
  '   asserting every `MembershipTier` resolves via `RigCatalog.rigClass(for:)` to a rig class with a',
  '   profile for every `DeviceClass`, plus a `LaunchSessionFlow` test for an Ultimate member on iPhone.',
  '   `swift test` (Core, Linux or macOS) and `scripts/verify-ios.sh` (macOS) must pass.',
  `   Do not change \`ClientIdentity\` (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}ios\`, \`${ERROR_PATH}\`) or the \`FailureReport\` payload.`,
  '4. Re-run the simulator reproduction on the fix commit and confirm the "Rig reserved" ticket for an',
  '   Ultimate member on iPhone, then that Performance still succeeds.',
  '5. Open a pull request against `main`, request Devin Review, and STOP for human approval.',
  '6. After approval, spawn a macOS child session that checks out the same fix commit SHA, runs',
  '   `RECORD=1 scripts/verify-ios.sh` (xcodebuild test + simulator launch + recording), drives Play',
  '   for an Ultimate member to the ticket screen, and posts the recording plus the verified commit SHA',
  '   to the PR.',
  '7. Confirm the recorded commit SHA matches the PR head before merge.',
].join('\n');

function clip(value, max) {
  const text = value == null ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** Keep only flat scalar launch metadata so Sentry/Slack payloads stay bounded. */
function sanitizeLaunch(launch) {
  if (!launch || typeof launch !== 'object' || Array.isArray(launch)) return {};
  const out = {};
  for (const [key, value] of Object.entries(launch)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[clip(key, 64)] = typeof value === 'string' ? clip(value, 256) : value;
    }
  }
  return out;
}

/** True when a request body comes from the GeForce NOW iOS client. */
function isAppSource(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return source.startsWith(APP_SOURCE_PREFIX);
}

/** True when a request body carries the GeForce NOW app identity. */
function isAppReport(body) {
  return isAppSource(body) && body.service === APP_SERVICE;
}

/**
 * Bridge a `FailureReport` posted by the GeForce NOW iOS client into the Slack
 * alert + Devin session flow under the app identity. The client has already
 * rendered its "couldn't start your session" card; this is telemetry only.
 */
function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'ios', 32);
  const screen = clip(report.screen || 'game_detail', 64);
  const action = clip(report.action || 'play', 64);
  const game = clip(report.game || 'unknown', 64);
  const tier = clip(report.tier || 'unknown', 32);
  const rigClass = clip(report.rigClass || 'unknown', 32);
  const device = clip(report.device || 'iPhone', 32);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion, 32);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Play failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const launch = sanitizeLaunch(report.launch);
  const reporterEmail = clip(report.devinEmail, 128);

  const tags = {
    route: ERROR_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    game,
    tier,
    rig_class: rigClass,
    device,
    scenario: SCENARIO,
  };

  incrementMetric('play.launch.failure', {
    route: ERROR_PATH,
    errorClass: errorType,
    platform,
    game,
    tier,
    rigClass,
    device,
  });

  logger.error('GeForce NOW app reported a failure', {
    reference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    game,
    tier,
    rigClass,
    device,
    osVersion,
    appVersion,
    errorClass: errorType,
    error: errorMessage,
    sentryEventId: report.sentryEventId || null,
  });

  // The client throws a typed Swift error (e.g. StreamProfileError.unregisteredRig);
  // keep its name so Sentry groups it as the app reported it.
  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  // The Swift frames above carry no Node module path, so Sentry derives the
  // issue culprit from the transaction; naming it after the route keeps the
  // customer slug in `issue.culprit` for tagless issue webhooks
  // (isInstantPathEvent in app/routes/sentry-webhook.js).
  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST ${ERROR_PATH}`);
    Sentry.captureException(error, {
      tags: { ...tags, alert_path: 'instant' },
      extra: {
        reference, release, environment, osVersion, appVersion, launch, sentryEventId: report.sentryEventId,
      },
    });
  });

  const sessionPromise = createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=is%3Aunresolved`,
    culprit: CULPRIT,
    errorType,
    errorValue: errorMessage,
    devinUserId: OWNER.devinUserId,
    devinEmail: OWNER.email,
    devinOrgId: OWNER.devinOrgId,
    slackMemberId: OWNER.slackMemberId,
    service: APP_SERVICE,
    verticalLabel: 'NVIDIA',
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference,
      stackTrace,
      osVersion,
      appVersion,
      sentryEventId: report.sentryEventId || null,
      launch,
      reporterEmail,
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
  }).catch((err) => {
    logger.error('Failed to create Devin session for GeForce NOW app failure report', {
      error: err.message,
      reference,
    });
  });

  return { reference, sessionPromise };
}

module.exports = {
  CUSTOMER,
  OWNER,
  APP_SERVICE,
  APP_PROJECT,
  APP_RELEASE,
  APP_SOURCE_PREFIX,
  APP_REPO,
  APP_REMEDIATION_DIRECTIVE,
  ERROR_PATH,
  SCENARIO,
  isAppReport,
  isAppSource,
  reportAppFailure,
};
