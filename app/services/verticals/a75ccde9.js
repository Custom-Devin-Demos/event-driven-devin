const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

const CUSTOMER = 'a75ccde9';
const APP_SERVICE = 'customer-a75ccde9-web';
const APP_PROJECT = 'event-driven-devin';
const APP_RELEASE = 'a75ccde9-web@1.0.0';
const APP_SOURCE_PREFIX = 'plan-page-web/';
const SCENARIO = 'plan-change-annual-pricing';
const ALERT_COOLDOWN_MS = Number(process.env.A75CCDE9_ALERT_COOLDOWN_MS) || 60 * 60 * 1000;

let lastAlertAt = 0;

function resetAlertCooldown() {
  lastAlertAt = 0;
}

const OWNER = {
  slackMemberId: '',
  email: 'yubin.jee@cognition.ai',
};

const APP_REMEDIATION_DIRECTIVE = [
  '*Repository to fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code is the inline script in `app/public/verticals/a75ccde9.html`, specifically',
  '`renderPlanPricing`, served at `https://devindemos.com/oncall/c/a75ccde9`.',
  'The page is served by `app/routes/oncall.js` from `config/oncall-skins.js`.',
  'Run locally with `PORT=3100 node app/server.js` and open `/oncall/c/a75ccde9`.',
  '',
  'Steps:',
  '1. Start a screen recording with `recording_start` before you touch any code — the recording is',
  'a required deliverable, not optional. Then reproduce on your LOCAL server (never on the live',
  'URL — every Annual click there raises a new production alert): on the plan page click the',
  '"Annual" billing toggle with the default plan selected. Pricing fails to switch and a notice',
  'appears; screenshot the failure and annotate the recording with what failed.',
  '2. Fix the data/render mismatch, not just the crash site. Every offered plan must have complete',
  'monthly and annual pricing. `renderPlanPricing` must explicitly reject a missing billing period',
  'with a typed error and use the existing notice instead of dereferencing undefined.',
  '3. Add a test under `tests/` that loads the page HTML, extracts `PLAN_PRICING`, and asserts',
  'that every offered plan has monthly and annual pricing.',
  '4. Re-run the reproduction locally on the fix commit. Annual must show annual prices and savings',
  'for every plan; capture screenshots of the successful state.',
  '5. Keep the same recording running across the before and after passes (or record the local',
  'fixed run immediately after the live failure) so the two play back to back, use',
  '`annotate_recording` to mark the failing repro and the passing repro, then `recording_stop`.',
  'Attach the recording and both screenshots to the pull request. Freeze pushes while recording.',
  '6. Open a pull request against `main` with `Devin-Org: engineering` as its final line, post the',
  'PR link back, and stop for human approval. Do not merge.',
].join('\n');

function clip(value, max) {
  const text = value == null ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

function isAppSource(body) {
  return Boolean(body && typeof body.source === 'string'
    && body.source.startsWith(APP_SOURCE_PREFIX));
}

function isAppReport(body) {
  return isAppSource(body) && body.service === APP_SERVICE;
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
    logger.warn('Plan pricing reporter email not found in org', { orgId });
  } catch (error) {
    logger.warn('Plan pricing reporter lookup failed', { error: error.message, orgId });
  }
  return '';
}

function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'web', 32);
  const screen = clip(report.screen || 'plan_change', 64);
  const action = clip(report.action || 'toggle_annual_billing', 64);
  const planCode = clip(report.planCode || 'unknown', 64);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Annual pricing failed to render', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const devinEmail = clip(report.devinEmail || OWNER.email, 128);
  const tags = {
    route: '/api/a75ccde9/error',
    service: APP_SERVICE,
    customer: CUSTOMER,
    platform,
    screen,
    action,
    plan_code: planCode,
    scenario: SCENARIO,
  };

  incrementMetric('plan_change.pricing_failure', {
    route: '/api/a75ccde9/error',
    errorClass: errorType,
    platform,
    planCode,
  });

  logger.error('Plan pricing browser reported a failure', {
    reference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    planCode,
    errorClass: errorType,
    error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  Sentry.withScope((scope) => {
    scope.setTransactionName('POST /api/a75ccde9/error');
    Sentry.captureException(error, {
      tags: { ...tags, alert_path: 'instant' },
      extra: { reference, release, environment, planCode },
    });
  });

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=is%3Aunresolved`,
    culprit: 'app/public/verticals/a75ccde9.html — renderPlanPricing',
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail,
    devinOrgId: report.devinOrgId,
    slackMemberId: OWNER.slackMemberId,
    slackMemberIdFallback: OWNER.slackMemberId,
    service: APP_SERVICE,
    verticalLabel: 'FOX One',
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: { reference, stackTrace, planCode },
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

  const now = Date.now();
  if (now - lastAlertAt < ALERT_COOLDOWN_MS) {
    logger.warn('Plan pricing alert suppressed by cooldown', {
      reference,
      cooldownMs: ALERT_COOLDOWN_MS,
      msSinceLastAlert: now - lastAlertAt,
    });
    return { reference, sessionPromise: Promise.resolve({ triggered: false, suppressed: true }) };
  }
  lastAlertAt = now;

  const needsLookup = !report.devinUserId && devinEmail && report.devinOrgId;
  const sessionPromise = (needsLookup
    ? resolveUserIdByEmail(devinEmail, report.devinOrgId)
      .then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(report.devinUserId)
  ).catch((error) => {
    logger.error('Failed to create Devin session for plan pricing failure report', {
      error: error.message,
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
  CUSTOMER,
  OWNER,
  SCENARIO,
  isAppReport,
  isAppSource,
  reportAppFailure,
  resetAlertCooldown,
  resolveUserIdByEmail,
};
