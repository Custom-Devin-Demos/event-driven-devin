const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Splash Sports mobile app (github.com/COG-GTM/splash-sports-mobile).
 *
 * Unlike the other verticals, the product surface is not served from this
 * host: it is an Expo / React Native app running in Expo Web, the iOS
 * Simulator or an Android emulator. The app catches failures in its own
 * user actions and POSTs them to /api/3aa9fa04/app/error, and this service
 * bridges that report into the Slack alert + Devin session flow under the
 * mobile identity.
 */
const APP_SERVICE = 'customer-3aa9fa04-mobile';
const APP_PROJECT = 'splash-sports-mobile';
const APP_RELEASE = 'splash-sports-mobile@1.0.0';
const APP_SOURCE_PREFIX = 'splash-sports-mobile/';

/**
 * Scenario directive appended to the Devin investigation prompt. The alert
 * pipeline passes only a prompt to the Devin API, so the repository to
 * remediate has to be named explicitly here.
 */
const APP_REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `github.com/COG-GTM/splash-sports-mobile` (Expo SDK 57 / React Native / TypeScript)',
  '',
  'This error was raised by the Splash Sports mobile app during an NFL primetime slate. The app',
  'reports failures from its own user actions; there is no server-side code path for it on this host.',
  'Read `AGENTS.md` in that repo first.',
  '',
  'The failing code path is QuickPicks entry submission:',
  '- Screen: `src/screens/EntrySlipScreen.tsx` ("Submit entry" button)',
  '- State: `src/state/AppState.tsx` (`submitSlip`)',
  '- Business logic: `src/lib/payout.ts` and `src/lib/slate.ts` (primetime boost / slate window)',
  '- Mock slate data: `src/data/nfl.ts` (NFL 2026 Week 2: TNF, Sunday slates, SNF, MNF)',
  '',
  'Steps:',
  '1. Reproduce first: `npm install`, then `CI=1 npx expo start --web --port 8081` and open',
  '   http://localhost:8081. Go to QuickPicks, pick two players from the game named in the alert',
  '   tags, open the entry slip and tap "Submit entry" — confirm the error card. Then run',
  '   `npm test`: add a failing unit test in `src/lib/__tests__/` that pins the crash before fixing.',
  '2. Fix the data/logic gap in `src/lib/`, not just the crash site: every primetime window the',
  '   slate can produce must resolve to a boost, and an unknown window must degrade to no boost',
  '   instead of throwing. Keep all kickoff/lock times as UTC ISO strings displayed in',
  '   `America/New_York`. Do not change the error reporter service name (`customer-3aa9fa04-mobile`).',
  '3. `npm run typecheck`, `npm run lint`, `npm test` and `npm run build:web` must pass.',
  '4. Re-run the web reproduction on the fix commit and confirm the "YOU\'RE IN!" confirmation.',
  '   Include a screenshot in the PR. If an Android emulator is available (`emulator -list-avds`),',
  '   also verify with `npm run android` and attach an `adb exec-out screencap -p` screenshot.',
  '5. Open a pull request against `main` and STOP for human review. Do not merge.',
].join('\n');

function clip(value, max) {
  const text = value == null ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** True when a request body carries the Splash mobile identity. */
function isAppReport(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return source.startsWith(APP_SOURCE_PREFIX) && body.service === APP_SERVICE;
}

/**
 * Bridge a failure reported by the Splash mobile client (web, iOS or Android)
 * into the Slack alert + Devin session flow under the mobile identity.
 * The client has already rendered its error card; this is telemetry only.
 */
function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'web', 32);
  const screen = clip(report.screen || 'entry-slip', 64);
  const action = clip(report.action || 'submit_entry', 64);
  const slate = clip(report.slate || 'unknown', 64);
  const game = clip(report.game || 'unknown', 64);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'App action failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const extra = report.extra && typeof report.extra === 'object' ? report.extra : {};

  const tags = {
    route: '/api/3aa9fa04/app/error',
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    slate,
    game,
    scenario: 'nfl-primetime-entry',
  };

  incrementMetric('mobile_entry.failure', {
    route: '/api/3aa9fa04/app/error',
    errorClass: errorType,
    platform,
    slate,
  });

  logger.error('Splash mobile app reported a failure', {
    reference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    slate,
    game,
    errorClass: errorType,
    error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  Sentry.captureException(error, {
    tags,
    extra: { reference, release, environment, ...extra },
  });

  const sessionPromise = createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=is%3Aunresolved`,
    culprit: clip(report.culprit || 'src/state/AppState.tsx \u2014 submitSlip', 160),
    errorType,
    errorValue: errorMessage,
    devinUserId: report.devinUserId,
    devinEmail: report.devinEmail || 'adam.achebe@cognition.ai',
    devinOrgId: report.devinOrgId,
    service: APP_SERVICE,
    verticalLabel: 'Splash Sports Mobile',
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    customer: '3aa9fa04',
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: { reference, stackTrace, ...extra },
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
    logger.error('Failed to create Devin session for Splash mobile failure report', {
      error: err.message,
      reference,
    });
  });

  return { reference, sessionPromise };
}

module.exports = {
  APP_SERVICE,
  APP_PROJECT,
  APP_RELEASE,
  APP_SOURCE_PREFIX,
  APP_REMEDIATION_DIRECTIVE,
  isAppReport,
  reportAppFailure,
};
