const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

// CommBiz app client in github.com/COG-GTM/event-driven-ios (CommBizApp/, the
// Flutter business-banking app hosted at /commbizapp and run natively on iOS).
// The app reports its own platform failures here; this host only bridges them
// to Sentry, Slack and a Devin session scoped to that repo.
// On-call mention is resolved from the report's devinEmail; COMMBIZ_SLACK_MEMBER_ID is an
// optional env opt-in fallback. No named person is hard-coded here (see AGENTS.md).
const COMMBIZ_SLACK_MEMBER_ID = process.env.COMMBIZ_SLACK_MEMBER_ID || '';
const APP_SERVICE = 'customer-commbiz-ios';
const APP_PROJECT = 'commbiz-mobile-ios';
const APP_RELEASE_PREFIX = 'commbiz-app-flutter@';
const APP_RELEASE = `${APP_RELEASE_PREFIX}1.0.0`;
const APP_SOURCE_PREFIX = 'commbiz-mobile/';
const APP_REPO = 'github.com/COG-GTM/event-driven-ios';
const IOS_ERROR_PATH = '/api/commbiz/ios/error';
const APP_SCENARIO = 'authoriser-entitlement-key';
const APP_CULPRIT = 'CommBizApp/lib/core/authoriser_entitlements.dart — AuthoriserEntitlementRegistry.keyFor';
const APP_WEB_PATH = '/commbizapp';
// Fix sessions must drive the iOS Simulator, so place them on a macOS VM.
// Set COMMBIZ_IOS_SESSION_PLATFORM to the org's macOS platform label (or '' for the org default).
const COMMBIZ_IOS_SESSION_PLATFORM = process.env.COMMBIZ_IOS_SESSION_PLATFORM === undefined
  ? 'macos'
  : process.env.COMMBIZ_IOS_SESSION_PLATFORM;
const APP_SENTRY_ISSUE_QUERY = 'is:unresolved AuthorisationEntitlementError';

const APP_REMEDIATION_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\`

\`COG-GTM/event-driven-ios\` holds several mobile clients. This alert comes from the CommBiz app in
\`CommBizApp/\` (Dart/Flutter; runs in the browser at \`${APP_WEB_PATH}\` on this host and natively on the
iOS simulator; \`platform\` is \`web\` or \`ios\`). Read the repo's \`AGENTS.md\` first and leave every other
app in that repo untouched — in particular \`CommBankApp/\` (the retail CommBank app) is a separate
codebase with its own seed data. The NetBank web demo on this host (\`/cba\`) and the hosted CommBank app
(\`/commbankapp\`) are unrelated surfaces — do not modify them.

The failing path is Authorise → Wages week 43 → Authorise (log on first with User ID \`104882917\`, any
password, any 6-digit token code):
- Client identity: \`${APP_SERVICE}\`, source prefix \`${APP_SOURCE_PREFIX}\`, report endpoint \`${IOS_ERROR_PATH}\`
- Registry: \`CommBizApp/lib/core/authoriser_entitlements.dart\`; crash site \`${APP_CULPRIT}\`, thrown
  from \`AuthoriserEntitlements.resolve\` and surfaced by \`AppModel.authorise\` in \`CommBizApp/lib/app_model.dart\`.

Background: CommBiz is moving payment authorisation off the legacy channel's role codes (\`AUTH_L1\`,
\`AUTH_L2\`, carried on the signed-in user) and onto the central entitlement keys of the
payment-authorisation service (\`payments.authorise.tier1\`, \`payments.authorise.tier2\`). Tier 1 is a
payment that needs one authoriser; tier 2 is a payment that needs two (the existing $10,000+ rule).
\`AuthoriserEntitlementRegistry\` maps each legacy role code to its central key and the client resolves
the key for the tier a payment needs before recording the authorisation.

The defect is that the registry maps \`AUTH_L1\` (and the non-authorising roles) but never maps
\`AUTH_L2\` — the tier-2 code was left out when the registry was lifted from the legacy entitlement
table. \`AuthoriserEntitlementRegistry.keyFor('AUTH_L2')\` therefore returns null and
\`AppModel.authorise\` fails with \`AuthorisationEntitlementError.unmappedRoleCode\` (code
\`CBZ-AUTH-4031\`). Every dual-authorisation payment fails (Wages week 43, $48,620.00, 14 employees,
and any other payment that needs two authorisers), while single-authoriser payments such as Jarrah
Timber Supplies ($3,975.50) and Decline keep working.

Steps:
1. Reproduce with failure reporting OFF. From \`CommBizApp/\`: \`flutter test\`, then
   \`flutter run -d chrome --dart-define=CBZ_DISABLE_FAILURE_REPORTS=1\` for the browser, and on a macOS
   session \`flutter run -d <iPhone simulator> --dart-define=CBZ_DISABLE_FAILURE_REPORTS=1\` for iOS.
   Log on, open the Authorise tab, tap Wages week 43, tap Authorise and confirm "We couldn't authorise
   this payment right now. Please try again later. Ref CBZ-AUTH-4031". Jarrah Timber Supplies should
   continue to authorise.
2. Fix the data, not just the crash site: add the \`AUTH_L2\` → \`payments.authorise.tier2\` entry to
   \`AuthoriserEntitlementRegistry.centralKeys\` (tier 2, with a per-payment limit that covers the
   payments seeded as needing two authorisers), and keep the lookup failing with a typed error for
   genuinely unknown role codes rather than crashing.
3. Add a completeness test asserting every authorising legacy role code (\`AUTH_L1\`, \`AUTH_L2\`) resolves
   to a central key for its tier, and flip the existing payroll-batch tests from the failure to
   Partially authorised (first of two authorisers) / Authorised (second). \`flutter analyze\` and
   \`flutter test\` must be green.
4. Update the CommBiz section of \`AGENTS.md\` and \`CommBizApp/README.md\`: remove the "intentionally omits
   AUTH_L2" wording and describe the registry as complete. Keep the client identity (\`${APP_SERVICE}\`,
   \`${APP_SOURCE_PREFIX}<platform>\`, \`${IOS_ERROR_PATH}\`) and the report payload shape unchanged.
   Re-run the repro on the fix commit and confirm Wages week 43 shows "1 payment authorised" with the
   second-authoriser note.
5. Open a PR against \`main\`, request Devin Review, and STOP for human approval.
   The PR description must explain, for a reviewer who has never seen this code and in short plain
   sentences: (a) that the app still carries legacy role codes on the user while the authorisation
   check is keyed on central entitlement keys, and the registry that maps one to the other had no
   entry for AUTH_L2; (b) why only dual-authorisation payments were affected — tier 1 resolves through
   AUTH_L1, which is mapped, and tier 2 is the only tier that needs AUTH_L2; (c) why adding the
   AUTH_L2 → payments.authorise.tier2 mapping is the right fix rather than skipping the check or
   falling back to tier 1.
6. After approval, verify on a macOS child session with a recording of the iOS simulator run
   (\`flutter run -d <iPhone simulator>\`).

All reproductions must run with failure reporting off (\`CBZ_DISABLE_FAILURE_REPORTS=1\`) so they do not
spawn extra alerts or sessions.`;

function clip(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function isAppRelease(release) {
  return typeof release === 'string' && release.startsWith(APP_RELEASE_PREFIX);
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
  const screen = clip(report.screen || 'authorise', 64);
  const action = clip(report.action || 'authorise', 64);
  const clientReference = clip(report.reference, 64);
  const paymentId = clip(report.paymentId, 64);
  const paymentRef = clip(report.paymentRef, 64);
  const paymentType = clip(report.paymentType || 'unknown', 32);
  const paymentName = clip(report.paymentName || 'unknown', 128);
  const amount = Number.isFinite(report.amount) ? report.amount : clip(report.amount, 64);
  const authorisersRequired = Number.isFinite(report.authorisersRequired) ? report.authorisersRequired : clip(report.authorisersRequired, 8);
  const tier = Number.isFinite(report.tier) ? report.tier : clip(report.tier, 8);
  const roleCode = clip(report.roleCode || 'unknown', 32);
  const roleCodes = Array.isArray(report.roleCodes) ? report.roleCodes.map((code) => clip(code, 32)) : [];
  const fromAccount = clip(report.fromAccount || 'unknown', 64);
  const toLabel = clip(report.toLabel, 128);
  const lineCount = Number.isFinite(report.lineCount) ? report.lineCount : clip(report.lineCount, 8);
  const batchSize = Number.isFinite(report.batchSize) ? report.batchSize : 1;
  const device = clip(report.device || 'iPhone', 32);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion, 32);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorCode = clip(report.errorCode, 32);
  const errorMessage = clip(report.errorMessage || 'Authorise failed', 512);
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
    payment_type: paymentType,
    tier: String(tier),
    role_code: roleCode,
    error_code: errorCode,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('commbiz.ios.authorise.failure', {
    route: IOS_ERROR_PATH,
    errorClass: errorType,
    platform,
    screen,
    action,
    paymentType,
    tier,
    roleCode,
  });

  logger.error('CommBiz app reported an authorisation failure', {
    reference,
    clientReference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    paymentId,
    paymentRef,
    paymentType,
    paymentName,
    amount,
    authorisersRequired,
    tier,
    roleCode,
    fromAccount,
    batchSize,
    device,
    osVersion,
    appVersion,
    errorClass: errorType,
    errorCode,
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
    paymentId,
    paymentRef,
    paymentType,
    paymentName,
    amount,
    authorisersRequired,
    tier,
    roleCode,
    roleCodes,
    fromAccount,
    toLabel,
    lineCount,
    batchSize,
    device,
    osVersion,
    appVersion,
    errorCode,
  };

  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST ${IOS_ERROR_PATH}`);
    // Label the event with the app's release/environment rather than this host's.
    scope.addEventProcessor((event) => ({ ...event, release, environment }));
    Sentry.captureException(error, { tags, extra });
  });

  const sessionPromise = createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=${encodeURIComponent(APP_SENTRY_ISSUE_QUERY)}`,
    culprit: APP_CULPRIT,
    errorType,
    errorValue: errorMessage,
    devinUserId: report.devinUserId,
    devinEmail: report.devinEmail,
    devinOrgId: report.devinOrgId,
    slackMemberId: '',
    slackMemberIdFallback: COMMBIZ_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: `CommBiz app — Authorise payments (${platform})`,
    customer: 'cba',
    project: APP_PROJECT,
    release,
    sessionPlatform: COMMBIZ_IOS_SESSION_PLATFORM || undefined,
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra,
    triggeredRule: '',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for CommBiz authorisation failure', {
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
  APP_RELEASE_PREFIX,
  APP_SOURCE_PREFIX,
  APP_REPO,
  IOS_ERROR_PATH,
  APP_SCENARIO,
  APP_CULPRIT,
  APP_WEB_PATH,
  APP_SENTRY_ISSUE_QUERY,
  COMMBIZ_IOS_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  isAppRelease,
  isAppSource,
  isAppReport,
  reportAppFailure,
};
