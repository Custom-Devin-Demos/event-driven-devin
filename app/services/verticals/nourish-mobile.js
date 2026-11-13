const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const logger = require('../../telemetry/logger');

const ERROR_PATH = '/api/nourish/mobile/error';
const REPO = 'COG-GTM/nourish-mobile-demo';
const CULPRIT = 'nourish/mobile NourishCore/Sources/NourishCore/MealAnalysis/';
const VALUES = Object.freeze({
  schemaVersion: 1,
  errorCode: 'NOURISH-MEAL-ANALYSIS-001',
  fixtureId: 'avocado-toast-incomplete',
  screen: 'meal-review',
  appVersion: '1.0.0',
});
const PROMPT = `Investigate only ${REPO}, a dependency-free native Swift/SwiftUI app.
Read the current README and AGENTS.md for the exact Xcode project, scheme and build commands.
Reproduce the incomplete-nutrients mapping defect in the seeded avocado-toast-incomplete response,
surfaced as a Swift error in NourishCore/Sources/NourishCore/MealAnalysis/ and the NourishMobile/ UI.
It may be a caught domain error rather than a fatal trap; do not require an uncaught crash.
Then fix missing-nutrient handling defensively in the native module with regression coverage.
Keep the native planner scaffold and baseline untouched.
Keep reports OFF during all reproduction: NOURISH_DISABLE_FAILURE_REPORTS=1.
Run swift test --package-path NourishCore and an Xcode build using the current repo instructions.
Use the testing agent for before/after iPhone Simulator verification with recordings and screenshots.
Work in this macOS session; create no child sessions.
If macOS/Simulator is unavailable, report the blocker; do not delegate or claim simulator verification.
Open a DRAFT [DO NOT MERGE] remediation PR against main; never merge.`;

function validReport(body) {
  return !!body && typeof body === 'object' && !Array.isArray(body)
    && Object.keys(body).length === 6
    && Object.entries(VALUES).every(([key, value]) => Object.hasOwn(body, key) && body[key] === value)
    && Object.hasOwn(body, 'platform') && ['ios', 'android', 'web'].includes(body.platform);
}

function reportFailure(platform, reportId) {
  const message = 'Seeded meal analysis response is missing nutrients';
  const tags = { customer: 'nourish-mobile', service: 'customer-nourish-mobile',
    route: ERROR_PATH, alert_path: 'instant', platform, error_code: VALUES.errorCode };
  const extra = { ...VALUES, platform, reportId };
  logger.error('Nourish mobile app reported a failure', {
    customer: tags.customer, service: tags.service, route: ERROR_PATH,
    errorCode: VALUES.errorCode, fixtureId: VALUES.fixtureId, screen: VALUES.screen,
    platform, appVersion: VALUES.appVersion, reportId,
  });
  const error = new Error(message);
  error.name = VALUES.errorCode;
  error.stack = `${VALUES.errorCode}: ${message}\n    at ${CULPRIT}:1:1`;
  Sentry.withScope((scope) => {
    // Do not retain request bodies, headers, breadcrumbs or ambient user context.
    scope.addEventProcessor((event) => ({
      event_id: event.event_id, timestamp: event.timestamp,
      exception: event.exception, level: 'error', platform: 'node',
      culprit: CULPRIT, transaction: `POST ${ERROR_PATH}`,
      release: 'nourish-mobile@1.0.0', tags, extra,
    }));
    Sentry.captureException(error, { tags, extra });
  });
  Promise.resolve().then(() => createSessionAndAlert({
    customer: 'nourish-mobile', service: 'customer-nourish-mobile',
    verticalLabel: 'Nourish — Meal analysis', project: 'nourish-mobile',
    issueTitle: `${VALUES.errorCode}: ${message}`, errorType: VALUES.errorCode,
    errorValue: message, culprit: CULPRIT, level: 'error',
    repos: [REPO], sessionPlatform: 'macos', promptAppendix: PROMPT,
    skipVulnerablePr: true, release: 'nourish-mobile@1.0.0',
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })), extra,
  })).catch((error) => logger.error('Nourish report alert failed', { reportId, error: error.message }));
}

module.exports = { ERROR_PATH, REPO, CULPRIT, VALUES, PROMPT, validReport, reportFailure };
