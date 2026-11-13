const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const logger = require('../../telemetry/logger');

const ERROR_PATH = '/api/nourish/mobile/error';
const REPO = 'COG-GTM/nourish-mobile-demo';
const CULPRIT = 'nourish/mobile src/features/meal-analysis/';
const VALUES = Object.freeze({
  schemaVersion: 1,
  errorCode: 'NOURISH-MEAL-ANALYSIS-001',
  fixtureId: 'avocado-toast-incomplete',
  screen: 'meal-review',
  appVersion: '1.0.0',
});
const PROMPT = `Investigate only ${REPO} (React Native / Expo), in src/features/meal-analysis/.
Reproduce the seeded avocado-toast-incomplete meal analysis response with missing nutrients,
then fix handling defensively with regression coverage. Preserve baseline and planner modules.
Keep reports OFF during all reproduction: EXPO_PUBLIC_NOURISH_DISABLE_FAILURE_REPORTS=1.
Run lint, typecheck and tests. Build and run in the iPhone Simulator before and after;
save recordings and screenshots. Work in this macOS session, with no child-session parallelization.
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
  })).catch(() => logger.error('Nourish report alert failed', { reportId }));
}

module.exports = { ERROR_PATH, REPO, CULPRIT, VALUES, PROMPT, validReport, reportFailure };
