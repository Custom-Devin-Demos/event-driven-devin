const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

const CHAPTER_SLACK_MEMBER_ID = process.env.CHAPTER_SLACK_MEMBER_ID || '';
const CUSTOMER = 'ios-demos';
const APP_SERVICE = 'customer-chapter-ios';
const APP_PROJECT = 'chapter-otc-ios';
const APP_RELEASE = 'chapter-otc-ios@2.4.0';
const APP_SOURCE_PREFIX = 'chapter-otc/';
const APP_REPO = 'github.com/COG-GTM/event-driven-ios';
const IOS_ERROR_PATH = '/api/chapter/ios/error';
const APP_SCENARIO = 'otc-checkout-h1036-236-unmapped-fulfillment';
const APP_CULPRIT = 'ChapterCore/Sources/ChapterCore/OTCCheckout.swift — OTCCheckoutService.placeOrder(cart:benefit:member:now:sequence:)';
const APP_SENTRY_ISSUE_QUERY = 'is:unresolved OTCError.fulfillmentProgramNotFound';
// Fix sessions must drive the iOS Simulator, so place them on a macOS VM.
// Set CHAPTER_IOS_SESSION_PLATFORM to the org's macOS platform label (or '' for the org default).
const CHAPTER_IOS_SESSION_PLATFORM = process.env.CHAPTER_IOS_SESSION_PLATFORM === undefined
  ? 'macos'
  : process.env.CHAPTER_IOS_SESSION_PLATFORM;

const APP_REMEDIATION_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\` (Swift / SwiftUI, native iOS)

This is the Chapter OTC iOS app (askchapter.org Medicare Advantage OTC benefits) in \`COG-GTM/event-driven-ios\`,
folders \`ChapterCore/\` and \`ChapterMobile/\`. Investigate and fix that Swift repository only: not this Node
repository, and not the other apps in it (HUB24, Westpac, CommBank, Housecall Pro, DICK'S, DataCamp, Mac Tools).
Read its \`AGENTS.md\` and \`ChapterMobile/README.md\` first.

The failing path is the OTC benefit checkout (Shop -> Pain Relief -> Tylenol + Zyrtec -> Cart -> Checkout -> Place order):
- Client identity: \`${APP_SERVICE}\`, source prefix \`${APP_SOURCE_PREFIX}\`, report endpoint \`${IOS_ERROR_PATH}\`
- Crash site: \`${APP_CULPRIT}\` throws \`OTCError.fulfillmentProgramNotFound\` (\`CH-OTC-4041\`)
- Fulfillment mapping: \`OTCFulfillmentPrograms.programs\` in the same file maps each Medicare plan ID to an OTC fulfillment program
- Seed: \`ChapterCore/Sources/ChapterCore/SeedData.swift\` — member Linda Morales (\`CH-2041887\`) is on Humana Gold Plus
  \`H1036-236\` for 2026, which crosswalked from the 2025 plan \`H1036-200\`

Steps:
1. This session is requested on macOS. Confirm with \`uname -s\` and \`xcodebuild -version\`: on macOS, do all the work here and do not create child sessions; only if this session is not on macOS (platform fallback), create one macOS child session for the simulator work. Reproduce on the iOS simulator with
   \`make run-chapter\` (sets \`CHAPTER_DISABLE_FAILURE_REPORTS=1\` by default; \`CHAPTER_SEED_CART=1\` starts with Tylenol + Zyrtec in the cart):
   Checkout -> Place order, and confirm \`CH-OTC-4041\` for plan \`H1036-236\`.
2. Fix the root cause so 2026 Humana Gold Plus OTC orders route to the correct fulfillment program; do not swallow the
   error, charge the member, or switch the member to another plan.
3. Remove the \`XCTExpectFailure\` / skip wrapper from the seeded Humana checkout test in
   \`ChapterCore/Tests/ChapterCoreTests/OTCCheckoutTests.swift\`, add a regression test, and verify with
   \`swift test --package-path ChapterCore\` and \`make test-chapter\` / \`make ui-test-chapter\`.
4. Keep the client identity (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}ios\`, \`POST ${IOS_ERROR_PATH}\`)
   and the report payload shape unchanged. Re-run the simulator repro on the fix commit.
5. Open a **draft** PR against \`main\` of \`COG-GTM/event-driven-ios\` titled with a \`[DEMO — DO NOT MERGE]\` prefix, request Devin Review, post findings back to the Slack thread, and never merge it: the planted defect on \`main\` is kept for future demos.

Reproduction safety: every platform failure report raises a real Slack alert and Devin session. Always
run the app with \`CHAPTER_DISABLE_FAILURE_REPORTS=1\` (\`make run-chapter\` and the UI tests set it) unless the
alert chain is intentionally being exercised.`;

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
    logger.warn('Chapter iOS reporter email not found in org', { orgId });
  } catch (error) {
    logger.warn('Chapter iOS reporter lookup failed', { error: error.message, orgId });
  }
  return '';
}

function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'ios', 32);
  const screen = clip(report.screen || 'otc_checkout', 64);
  const action = clip(report.action || 'place_otc_order', 64);
  const memberId = clip(report.memberId || 'unknown', 32);
  const planId = clip(report.planId || 'unknown', 32);
  const planName = clip(report.planName || 'unknown', 128);
  const planYear = clip(report.planYear || 'unknown', 8);
  const carrierId = clip(report.carrierId || 'unknown', 32);
  const crosswalkFrom = clip(report.crosswalkFrom, 32);
  const zip = clip(report.zip, 10);
  const cartTotal = clip(report.cartTotal || 'unknown', 32);
  const benefitRemaining = clip(report.benefitRemaining || 'unknown', 32);
  const items = clip(report.items || 'none', 512);
  const errorCode = clip(report.errorCode || 'unknown', 32);
  const device = clip(report.device || 'iPhone', 64);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion, 32);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'OTC checkout failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const details = {
    platform,
    screen,
    action,
    memberId,
    planId,
    planName,
    planYear,
    carrierId,
    crosswalkFrom,
    zip,
    cartTotal,
    benefitRemaining,
    items,
    errorCode,
    device,
    osVersion,
    appVersion,
  };
  const tags = {
    route: IOS_ERROR_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    plan_id: planId,
    carrier_id: carrierId,
    error_code: errorCode,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('otc.ios.failure', {
    route: IOS_ERROR_PATH,
    errorClass: errorType,
    platform,
    screen,
    action,
    planId,
  });

  logger.error('Chapter OTC iOS app reported a failure', {
    reference,
    service: APP_SERVICE,
    ...details,
    errorClass: errorType,
    error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST ${IOS_ERROR_PATH}`);
    // Label the event with the native app's release/environment rather than this host's.
    scope.addEventProcessor((event) => ({ ...event, release, environment }));
    Sentry.captureException(error, {
      tags,
      extra: { reference, release, environment, ...details },
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
    slackMemberId: report.devinEmail ? '' : CHAPTER_SLACK_MEMBER_ID,
    slackMemberIdFallback: CHAPTER_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: 'Chapter OTC — Benefit Checkout (iOS)',
    customer: CUSTOMER,
    project: APP_PROJECT,
    release,
    sessionPlatform: CHAPTER_IOS_SESSION_PLATFORM || undefined,
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference,
      ...details,
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
    ? resolveUserIdByEmail(report.devinEmail, lookupOrgId)
      .then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(report.devinUserId)
  ).catch((alertError) => {
    logger.error('Failed to create Devin session for Chapter OTC iOS failure report', {
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
  APP_RELEASE,
  APP_SOURCE_PREFIX,
  APP_REPO,
  IOS_ERROR_PATH,
  APP_SCENARIO,
  APP_CULPRIT,
  CHAPTER_IOS_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  isAppSource,
  isAppReport,
  reportAppFailure,
  resolveUserIdByEmail,
};
