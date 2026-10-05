const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

const VERIZON_SLACK_MEMBER_ID = process.env.VERIZON_SLACK_MEMBER_ID || '';
const CUSTOMER = '4e150e99';
const APP_SERVICE = 'customer-verizon-ios';
const APP_PROJECT = 'my-verizon-ios';
const APP_RELEASE = 'my-verizon-ios@12.4.1';
const APP_SOURCE_PREFIX = 'my-verizon/';
const APP_REPO = 'github.com/COG-GTM/demo-verizon-ios';
const IOS_ERROR_PATH = '/api/verizon/ios/error';
const APP_SCENARIO = 'iphone18-preorder-receipt-unknown-line-item';
const APP_CULPRIT = 'MyVerizonCore/Sources/MyVerizonCore/Checkout/ReceiptFormatter.swift — ReceiptFormatter.receiptLine(_:)';
const APP_SENTRY_ISSUE_QUERY = 'is:unresolved OrderError.unknownLineItem';
// Fix sessions must drive the iOS Simulator, so place them on a macOS VM.
// Set VERIZON_IOS_SESSION_PLATFORM to the org's macOS platform label (or '' for the org default).
const VERIZON_IOS_SESSION_PLATFORM = process.env.VERIZON_IOS_SESSION_PLATFORM === undefined
  ? 'macos'
  : process.env.VERIZON_IOS_SESSION_PLATFORM;

const APP_REMEDIATION_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\` (Swift / SwiftUI, native iOS)

This is the native My Verizon iOS app in \`COG-GTM/demo-verizon-ios\`. Investigate and fix that Swift
repository only: not this Node repository, and not the Verizon web checkout vertical
(\`app/services/verticals/4e150e99.js\`). Read its \`AGENTS.md\` first.

The failing path is iPhone 18 preorder checkout (Place order on the checkout review screen):
- Client identity: \`${APP_SERVICE}\`, source prefix \`${APP_SOURCE_PREFIX}\`, report endpoint \`${IOS_ERROR_PATH}\`
- Crash site: \`${APP_CULPRIT}\` throws \`OrderError.unknownLineItem\`
- Order lines: \`MyVerizonCore/Sources/MyVerizonCore/Checkout/OrderPricing.swift\` appends the
  \`LaunchPromotions.iPhone18\` credit line \`PROMO-IP18-LAUNCH\`
- Catalog: \`MyVerizonCore/Sources/MyVerizonCore/Checkout/DeviceCatalog.swift\` —
  \`DeviceCatalog.product(sku:)\` only knows devices, plans and perks; promotions are not catalog products

The defect is that \`ReceiptFormatter.receiptLine(_:)\` resolves every order line through
\`DeviceCatalog.product(sku:)\`, so the launch-promotion credit line \`PROMO-IP18-LAUNCH\` has no catalog
product and the receipt throws \`OrderError.unknownLineItem\` for every iPhone 18 preorder.

Steps:
1. This session is requested on macOS. Confirm with \`uname -s\` and \`xcodebuild -version\`: on macOS, do all the work here and do not create child sessions; only if this session is not on macOS (platform fallback), create one macOS child session for the simulator work. Reproduce on the iOS simulator: \`make run\` (sets
   \`MYVZ_DISABLE_FAILURE_REPORTS=1\` by default), configure an iPhone 18 Pro preorder, tap Place order on
   checkout review, and confirm \`OrderError.unknownLineItem\` for \`PROMO-IP18-LAUNCH\`.
2. Fix the root cause so launch-promotion credit lines render on the receipt; do not just swallow the
   error or skip unknown lines.
3. Add a regression test in \`MyVerizonCore/Tests/MyVerizonCoreTests/\` and verify with
   \`swift test --package-path MyVerizonCore\` and \`make test\` (XcodeGen + iOS simulator; the repo's
   Makefile defaults to iPhone 17 / iOS 26.5).
4. Keep the client identity (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}ios\`, \`POST ${IOS_ERROR_PATH}\`)
   and the report payload shape unchanged. Re-run the simulator repro on the fix commit.
5. Open a **draft** PR against \`main\` of \`COG-GTM/demo-verizon-ios\` titled with a \`[DEMO — DO NOT MERGE]\` prefix, request Devin Review, post findings back to the Slack thread, and never merge it: the planted defect on \`main\` is kept for future demos.

Reproduction safety: every platform failure report raises a real Slack alert and Devin session. Always
run the app with \`MYVZ_DISABLE_FAILURE_REPORTS=1\` (\`make run\` sets it by default) unless the alert
chain is intentionally being exercised.`;

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
    logger.warn('My Verizon iOS reporter email not found in org', { orgId });
  } catch (error) {
    logger.warn('My Verizon iOS reporter lookup failed', { error: error.message, orgId });
  }
  return '';
}

function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'ios', 32);
  const screen = clip(report.screen || 'checkout_review', 64);
  const action = clip(report.action || 'place_order', 64);
  const deviceSku = clip(report.deviceSku || 'unknown', 64);
  const deviceName = clip(report.deviceName || 'unknown', 64);
  const storage = clip(report.storage || 'unknown', 32);
  const color = clip(report.color || 'unknown', 32);
  const planId = clip(report.planId || 'unknown', 64);
  const perks = clip(report.perks || 'none', 256);
  const tradeInDevice = clip(report.tradeInDevice || 'none', 64);
  const lineId = clip(report.lineId || 'unknown', 32);
  const orderNumber = clip(report.orderNumber || 'unknown', 64);
  const device = clip(report.device || 'iPhone', 32);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion, 32);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Place order failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const sentryEventId = clip(report.sentryEventId, 128);
  const tags = {
    route: IOS_ERROR_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    device_sku: deviceSku,
    plan_id: planId,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('preorder.ios.failure', {
    route: IOS_ERROR_PATH,
    errorClass: errorType,
    platform,
    screen,
    action,
    deviceSku,
    planId,
  });

  logger.error('My Verizon iOS app reported a failure', {
    reference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    deviceSku,
    deviceName,
    storage,
    color,
    planId,
    perks,
    tradeInDevice,
    lineId,
    orderNumber,
    device,
    osVersion,
    appVersion,
    errorClass: errorType,
    error: errorMessage,
    sentryEventId: sentryEventId || null,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST ${IOS_ERROR_PATH}`);
    Sentry.captureException(error, {
      tags,
      extra: {
        reference,
        release,
        environment,
        platform,
        screen,
        action,
        deviceSku,
        deviceName,
        storage,
        color,
        planId,
        perks,
        tradeInDevice,
        lineId,
        orderNumber,
        device,
        osVersion,
        appVersion,
        sentryEventId: sentryEventId || null,
      },
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
    slackMemberId: report.devinEmail ? '' : VERIZON_SLACK_MEMBER_ID,
    slackMemberIdFallback: VERIZON_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: 'My Verizon — iPhone 18 Preorder (iOS)',
    customer: CUSTOMER,
    project: APP_PROJECT,
    release,
    sessionPlatform: VERIZON_IOS_SESSION_PLATFORM || undefined,
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference,
      platform,
      screen,
      action,
      deviceSku,
      deviceName,
      storage,
      color,
      planId,
      perks,
      tradeInDevice,
      lineId,
      orderNumber,
      device,
      osVersion,
      appVersion,
      stackTrace,
      sentryEventId: sentryEventId || null,
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
    logger.error('Failed to create Devin session for My Verizon iOS app failure report', {
      error: alertError.message,
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
  APP_REPO,
  IOS_ERROR_PATH,
  APP_SCENARIO,
  APP_CULPRIT,
  VERIZON_IOS_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  isAppSource,
  isAppReport,
  reportAppFailure,
  resolveUserIdByEmail,
};
