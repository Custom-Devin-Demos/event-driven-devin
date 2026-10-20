const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

const MACTOOLS_SLACK_MEMBER_ID = process.env.MACTOOLS_SLACK_MEMBER_ID || '';
const CUSTOMER = 'ios-demos';
const APP_SERVICE = 'customer-mactools-ios';
const APP_PROJECT = 'mactools-amp-ios';
const APP_RELEASE = 'mactools-amp-ios@3.2.0';
const APP_SOURCE_PREFIX = 'mactools-amp/';
const APP_REPO = 'github.com/COG-GTM/event-driven-ios';
const IOS_ERROR_PATH = '/api/mactools/ios/error';
const APP_SCENARIO = 'weekly-payment-flex36-unmapped-plan';
const APP_CULPRIT = 'MacToolsCore/Sources/MacToolsCore/WeeklyPayment.swift — WeeklyPaymentProcessor.allocate(_:across:)';
const APP_SENTRY_ISSUE_QUERY = 'is:unresolved PaymentError.unmappedPlanCode';
// Fix sessions must drive the iOS Simulator, so place them on a macOS VM.
// Set MACTOOLS_IOS_SESSION_PLATFORM to the org's macOS platform label (or '' for the org default).
const MACTOOLS_IOS_SESSION_PLATFORM = process.env.MACTOOLS_IOS_SESSION_PLATFORM === undefined
  ? 'macos'
  : process.env.MACTOOLS_IOS_SESSION_PLATFORM;

const APP_REMEDIATION_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\` (Swift / SwiftUI, native iOS)

This is the Mac Tools AMP iOS app (Stanley Black & Decker) in \`COG-GTM/event-driven-ios\`, folders
\`MacToolsCore/\` and \`MacToolsMobile/\`. Investigate and fix that Swift repository only: not this Node
repository, and not the other apps in it (HUB24, Westpac, CommBank, Housecall Pro, DICK'S, DataCamp).
Read its \`AGENTS.md\` and \`MacToolsMobile/README.md\` first.

The failing path is the franchisee weekly collection payment (Pay tab -> Proceed to Payment -> Submit Payment):
- Client identity: \`${APP_SERVICE}\`, source prefix \`${APP_SOURCE_PREFIX}\`, report endpoint \`${IOS_ERROR_PATH}\`
- Crash site: \`${APP_CULPRIT}\` throws \`PaymentError.unmappedPlanCode\` (\`MT-PAY-4221\`)
- Ledger mapping: \`PaymentAllocationCodes.ledgerCodes\` in the same file maps each credit plan code to a ledger code
- Seed: \`MacToolsCore/Sources/MacToolsCore/SeedData.swift\` — account \`EC-48817\` is a Macsimizer workstation
  financed on the 0% Flex 36 promotion (plan code \`FLEX36\`)

Steps:
1. This session is requested on macOS. Confirm with \`uname -s\` and \`xcodebuild -version\`: on macOS, do all the work here and do not create child sessions; only if this session is not on macOS (platform fallback), create one macOS child session for the simulator work. Reproduce on the iOS simulator with
   \`make run-mactools\` (sets \`MACTOOLS_DISABLE_FAILURE_REPORTS=1\` by default): Pay tab -> Proceed to Payment ->
   Submit Payment, and confirm \`MT-PAY-4221\` for plan \`FLEX36\` on account \`EC-48817\`.
2. Fix the root cause so Flex 36 promotion allocations post to the correct ledger; do not swallow the error,
   skip the account, or move its payment to another account.
3. Remove the \`XCTExpectFailure\` wrapper from \`testSeededWeeklyPaymentPosts\` in
   \`MacToolsCore/Tests/MacToolsCoreTests/WeeklyPaymentTests.swift\`, add a regression test, and verify with
   \`swift test --package-path MacToolsCore\` and \`make test-mactools\` / \`make ui-test-mactools\`.
4. Keep the client identity (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}ios\`, \`POST ${IOS_ERROR_PATH}\`)
   and the report payload shape unchanged. Re-run the simulator repro on the fix commit.
5. Open a **draft** PR against \`main\` of \`COG-GTM/event-driven-ios\` titled with a \`[DEMO — DO NOT MERGE]\` prefix, request Devin Review, post findings back to the Slack thread, and never merge it: the planted defect on \`main\` is kept for future demos.

Reproduction safety: every platform failure report raises a real Slack alert and Devin session. Always
run the app with \`MACTOOLS_DISABLE_FAILURE_REPORTS=1\` (\`make run-mactools\` and the UI tests set it) unless the
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
    logger.warn('Mac Tools iOS reporter email not found in org', { orgId });
  } catch (error) {
    logger.warn('Mac Tools iOS reporter lookup failed', { error: error.message, orgId });
  }
  return '';
}

function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'ios', 32);
  const screen = clip(report.screen || 'payment_review', 64);
  const action = clip(report.action || 'submit_weekly_payment', 64);
  const customerNumber = clip(report.customerNumber || 'unknown', 32);
  const shopName = clip(report.shopName || 'unknown', 128);
  const accountId = clip(report.accountId || 'unknown', 64);
  const accountType = clip(report.accountType || 'unknown', 64);
  const planCode = clip(report.planCode || 'unknown', 32);
  const paymentAmount = clip(report.paymentAmount || 'unknown', 32);
  const accounts = clip(report.accounts || 'none', 512);
  const errorCode = clip(report.errorCode || 'unknown', 32);
  const device = clip(report.device || 'iPhone', 64);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion, 32);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Weekly payment failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const details = {
    platform,
    screen,
    action,
    customerNumber,
    shopName,
    accountId,
    accountType,
    planCode,
    paymentAmount,
    accounts,
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
    plan_code: planCode,
    error_code: errorCode,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('payment.ios.failure', {
    route: IOS_ERROR_PATH,
    errorClass: errorType,
    platform,
    screen,
    action,
    planCode,
  });

  logger.error('Mac Tools AMP iOS app reported a failure', {
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
    Sentry.captureException(error, {
      tags,
      extra: { reference, release, environment, ...details },
    });
  });

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=${encodeURIComponent(APP_SENTRY_ISSUE_QUERY)}`,
    culprit: `${APP_SOURCE_PREFIX}${platform} ${screen} ${action}`,
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail: report.devinEmail,
    devinOrgId: report.devinOrgId,
    slackMemberId: report.devinEmail ? '' : MACTOOLS_SLACK_MEMBER_ID,
    slackMemberIdFallback: MACTOOLS_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: 'Mac Tools AMP — Weekly Payment (iOS)',
    customer: CUSTOMER,
    project: APP_PROJECT,
    release,
    sessionPlatform: MACTOOLS_IOS_SESSION_PLATFORM || undefined,
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

  const needsLookup = !report.devinUserId && report.devinEmail && report.devinOrgId;
  const sessionPromise = (needsLookup
    ? resolveUserIdByEmail(report.devinEmail, report.devinOrgId)
      .then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(report.devinUserId)
  ).catch((alertError) => {
    logger.error('Failed to create Devin session for Mac Tools AMP iOS failure report', {
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
  MACTOOLS_IOS_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  isAppSource,
  isAppReport,
  reportAppFailure,
  resolveUserIdByEmail,
};
