const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

// CommBank app clients in github.com/COG-GTM/event-driven-ios: the Flutter app
// (CommBankApp/, hosted at /commbankapp and run natively on iOS) and the native
// SwiftUI app (CommBankMobile + CommBankCore). Both report their own platform
// failures here; this host only bridges them to Sentry, Slack and a Devin
// session scoped to that repo.
// On-call mention is resolved from the report's devinEmail; CBA_SLACK_MEMBER_ID is an
// optional env opt-in fallback. No named person is hard-coded here (see AGENTS.md).
const CBA_SLACK_MEMBER_ID = process.env.CBA_SLACK_MEMBER_ID || '';
const APP_SERVICE = 'customer-cba-ios';
const APP_PROJECT = 'commbank-mobile-ios';
const APP_RELEASE = 'commbank-mobile-ios@1.0.0';
const APP_SOURCE_PREFIX = 'commbank-mobile/';
const APP_REPO = 'github.com/COG-GTM/event-driven-ios';
const IOS_ERROR_PATH = '/api/cba/ios/error';
const APP_SCENARIO = 'payid-abn-addressing-profile';
const APP_CULPRIT = 'CommBankCore/Sources/CommBankCore/NPPAddressingProfiles.swift — NPPAddressingRegistry.profile(for:)';
const APP_FLUTTER_RELEASE_PREFIX = 'commbank-app-flutter@';
const APP_FLUTTER_CULPRIT = 'CommBankApp/lib/core/npp_addressing_profiles.dart — NPPAddressingRegistry.profileFor';
const APP_WEB_PATH = '/commbankapp';
const APP_SENTRY_ISSUE_QUERY = 'is:unresolved PaymentAddressingError';

const APP_REMEDIATION_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\`

\`COG-GTM/event-driven-ios\` holds two CommBank clients that share the same seeded data and the same
planted defect. Read the repo's \`AGENTS.md\` first and leave the HUB24 and Westpac apps untouched. The
NetBank web demo on this host (\`/cba\`, \`app/services/verticals/cba.js\`) is a separate, unrelated
surface — do not modify it.

Identify the client from the Sentry event's \`release\`:
- \`${APP_FLUTTER_RELEASE_PREFIX}*\` → the Flutter app in \`CommBankApp/\` (Dart; runs in the browser at
  \`${APP_WEB_PATH}\` on this host and natively on the iOS simulator). \`platform\` is \`web\` or \`ios\`.
  Registry: \`CommBankApp/lib/core/npp_addressing_profiles.dart\`; crash site \`${APP_FLUTTER_CULPRIT}\`,
  thrown from \`PaymentService.pay\` in \`CommBankApp/lib/core/payment_service.dart\`.
- \`${APP_PROJECT}@*\` → the native SwiftUI app (\`CommBankCore\` Swift package + \`CommBankMobile\` target).
  Registry: \`CommBankCore/Sources/CommBankCore/NPPAddressingProfiles.swift\`; crash site \`${APP_CULPRIT}\`,
  thrown from \`PaymentService.pay(_:)\`.

The failing path is Pay → Sunrise Plumbing Pty Ltd → Pay now → Confirm and pay:
- Client identity: \`${APP_SERVICE}\`, source prefix \`${APP_SOURCE_PREFIX}\`, report endpoint \`${IOS_ERROR_PATH}\`
- Seeded PayID types: \`email\`, \`mobile\`, and \`abn\` (the default payee, Sunrise Plumbing Pty Ltd, is an ABN PayID)

The defect is that \`NPPAddressingRegistry.profiles\` registers \`email\` and \`mobile\` but never
registers \`abn\` — business PayIDs shipped with the 2026 NetBank payee refresh without an addressing
profile. The lookup therefore returns nil/null and \`PaymentService.pay\` throws
\`PaymentAddressingError.unregisteredPayIdType\`, so Pay now fails for the default Sunrise Plumbing
payee while the email and mobile payees succeed.

Steps:
1. Reproduce with failure reporting OFF.
   Flutter (from \`CommBankApp/\`): \`flutter test\`, then \`flutter run -d chrome --dart-define=CBA_DISABLE_FAILURE_REPORTS=1\`
   for the browser, and on a macOS session \`flutter run -d <iPhone simulator> --dart-define=CBA_DISABLE_FAILURE_REPORTS=1\`
   for iOS. Native Swift: \`make generate && make test-commbank && CBA_DISABLE_FAILURE_REPORTS=1 make run-commbank\`.
   The Flutter app opens on Home with no log-on: tap Pay now on the "Invoice 80114 is due today" card (or open
   Pay → Sunrise Plumbing Pty Ltd → Pay now) → Confirm and pay, and confirm "We couldn't make this payment"
   with \`PaymentAddressingError.unregisteredPayIdType\`. The native app logs on first, then the same Pay flow. The Mia Thompson (mobile) and Daniel Okafor
   (email) payees should continue to succeed.
2. Fix the data, not just the crash site: register an accurate \`abn\` (business PayID) addressing profile
   that resolves against the NPP Addressing Service and is Osko eligible, and keep the lookup failing with
   a typed error for genuinely unknown types rather than crashing. Fix the client that reported; apply the
   same registry fix to the other client as well so the two stay in parity.
3. Add a completeness test asserting every \`PayIdType\` resolves to a registered addressing profile
   (\`flutter test\` for Dart, \`swift test --package-path CommBankCore\` for Swift). Keep both green.
4. Keep the client identity (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}<platform>\`, \`${IOS_ERROR_PATH}\`)
   and the report payload shape unchanged. Re-run the repro on the fix commit and confirm the Sunrise Plumbing
   payment now shows the "Payment successful" receipt.
5. Open a PR against \`main\`, request Devin Review, and STOP for human approval.
6. After approval, verify on a macOS child session with a recording of the iOS simulator run
   (\`flutter run -d <iPhone simulator>\` for the Flutter client).

All reproductions must run with failure reporting off (\`CBA_DISABLE_FAILURE_REPORTS=1\`) so they do not
spawn extra alerts or sessions.`;

function isFlutterRelease(release) {
  return typeof release === 'string' && release.startsWith(APP_FLUTTER_RELEASE_PREFIX);
}

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

function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'ios', 32);
  const screen = clip(report.screen || 'pay_anyone', 64);
  const action = clip(report.action || 'pay_now', 64);
  const clientReference = clip(report.reference, 64);
  const paymentMethod = clip(report.paymentMethod || 'unknown', 32);
  const payIdType = clip(report.payIdType || 'none', 32);
  const payId = clip(report.payId, 64);
  const payeeName = clip(report.payeeName || 'unknown', 128);
  const fromAccount = clip(report.fromAccount || 'unknown', 64);
  const accountProduct = clip(report.accountProduct || 'unknown', 64);
  const amount = Number.isFinite(report.amount) ? report.amount : clip(report.amount, 64);
  const description = clip(report.description, 64);
  const device = clip(report.device || 'iPhone', 32);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion, 32);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Pay now failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const tags = {
    route: IOS_ERROR_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    payment_method: paymentMethod,
    payid_type: payIdType,
    account_product: accountProduct,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('cba.ios.payment.failure', {
    route: IOS_ERROR_PATH,
    errorClass: errorType,
    platform,
    screen,
    action,
    paymentMethod,
    payIdType,
    accountProduct,
  });

  logger.error('CommBank iOS app reported a payment failure', {
    reference,
    clientReference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    paymentMethod,
    payIdType,
    payeeName,
    fromAccount,
    accountProduct,
    amount,
    device,
    osVersion,
    appVersion,
    errorClass: errorType,
    error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  const extra = {
    reference,
    clientReference,
    release,
    environment,
    platform,
    screen,
    action,
    paymentMethod,
    payIdType,
    payId,
    payeeName,
    fromAccount,
    accountProduct,
    amount,
    description,
    device,
    osVersion,
    appVersion,
  };

  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST ${IOS_ERROR_PATH}`);
    // Label the event with the native app's release/environment rather than this host's.
    scope.addEventProcessor((event) => ({ ...event, release, environment }));
    Sentry.captureException(error, { tags, extra });
  });

  const sessionPromise = createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=${encodeURIComponent(APP_SENTRY_ISSUE_QUERY)}`,
    culprit: isFlutterRelease(release) ? APP_FLUTTER_CULPRIT : APP_CULPRIT,
    errorType,
    errorValue: errorMessage,
    devinUserId: report.devinUserId,
    devinEmail: report.devinEmail,
    devinOrgId: report.devinOrgId,
    slackMemberId: '',
    slackMemberIdFallback: CBA_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: `CommBank app — Pay anyone (${platform})`,
    customer: 'cba',
    project: APP_PROJECT,
    release,
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra,
    triggeredRule: '',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for CommBank iOS payment failure', {
      reference,
      error: alertError.message,
    });
    return null;
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
  APP_FLUTTER_CULPRIT,
  APP_FLUTTER_RELEASE_PREFIX,
  APP_WEB_PATH,
  APP_REMEDIATION_DIRECTIVE,
  isFlutterRelease,
  isAppSource,
  isAppReport,
  reportAppFailure,
};
