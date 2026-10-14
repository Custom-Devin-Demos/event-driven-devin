const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');
const { NORDSTROM_ORG_ID } = require('./5b7227b4');

/**
 * Nordstrom Black Friday Gift Finder, native iOS (COG-GTM/ios-demos, apps/nordstrom-gift-finder).
 *
 * The app reports a failed final reservation to POST /api/5b7227b4/gift-finder/ios/error and
 * keeps the shopper on a recoverable failure state. This bridge raises the Slack alert and the
 * Devin remediation session against the Swift repository, under the Nordstrom customer when the
 * report carries the Nordstrom org and under the default (hub) config otherwise.
 */
const CUSTOMER = '5b7227b4';
const APP_SERVICE = `customer-${CUSTOMER}-gift-finder-ios`;
const APP_PROJECT = 'nordstrom-gift-finder-ios';
const APP_RELEASE = 'nordstrom-gift-finder@1.1.0';
const APP_SOURCE_PREFIX = 'nordstrom-gift-finder/';
const APP_REPO_NAME = 'COG-GTM/ios-demos';
const APP_REPO = `github.com/${APP_REPO_NAME}`;
const APP_DIR = 'apps/nordstrom-gift-finder';
const IOS_ERROR_PATH = '/api/5b7227b4/gift-finder/ios/error';
const APP_SCENARIO = 'gift-finder-partner-final-reservation';
const APP_STAGE = 'final_reservation';
const APP_CULPRIT = `${APP_DIR}/App/Services/ReservationService.swift — ReservationService.reserve(recipient:pickupItems:shippingItems:giftWrap:giftMessage:profiles:)`;
const APP_SENTRY_ISSUE_QUERY = `is:unresolved service:${APP_SERVICE}`;
// Fix sessions must drive the iOS Simulator, so place them on a macOS VM.
// Set GIFT_FINDER_IOS_SESSION_PLATFORM to the org's macOS platform label (or '' for the org default).
const GIFT_FINDER_IOS_SESSION_PLATFORM = process.env.GIFT_FINDER_IOS_SESSION_PLATFORM === undefined
  ? 'macos'
  : process.env.GIFT_FINDER_IOS_SESSION_PLATFORM;

/**
 * Customer config to raise the alert under. The Nordstrom service key only works inside the
 * Nordstrom org, so only a report that explicitly carries that org uses the 5b7227b4 config; the
 * native app normally carries no org and lands on the default (hub) org like other iOS bridges.
 */
function customerForOrg(orgId) {
  const nordstromOrg = process.env.DEVIN_ORG_ID_5B7227B4 || NORDSTROM_ORG_ID;
  return orgId && orgId === nordstromOrg ? CUSTOMER : 'default';
}

const APP_REMEDIATION_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\` (Swift / SwiftUI, native iOS), folder \`${APP_DIR}/\`

Partner gift reservations are failing at final reservation in the Nordstrom Black Friday Gift Finder iOS app.
Shoppers who build a brief for a Partner, add a pick to their bag and tap the primary reservation button
("Reserve for pickup" / "Place order" / "Reserve pickup & ship") never reach the confirmation: the app shows
"We couldn't complete your reservation." with an incident reference, and the hold is not submitted. Briefs for
every other recipient (Mom, Dad, Friend, Teen, Coworker) reserve normally and reach the \`NORD-4028\`
confirmation.

Investigate and fix \`${APP_REPO_NAME}\` only — not this Node repository. Work inside \`${APP_DIR}/\` and do not
touch other apps. Read the repo's \`README.md\` and \`${APP_DIR}/DEMO.md\` first.

Reported error:
- Type: \`ReservationError.missingFulfillmentProfile\`
- Message: "No fulfillment profile is configured for recipient 'partner'; the gift hold could not be submitted"
- Stage: \`${APP_STAGE}\` (screen \`bag\`, action \`reserve_pickup\`)
- Crash site: \`${APP_CULPRIT}\`
- Store: \`${APP_DIR}/App/Store/GiftStore.swift\` — \`GiftStore.checkout()\` calls the reservation service and
  shows the failure state on \`ReservationError\`
- Client identity: \`${APP_SERVICE}\`, source \`${APP_SOURCE_PREFIX}ios\`, report endpoint \`POST ${IOS_ERROR_PATH}\`

Reproduction (iOS Simulator):
1. \`make run APP=nordstrom-gift-finder\` with failure reports off
   (\`SIMCTL_CHILD_NORDSTROM_DISABLE_FAILURE_REPORTS=1\`), or launch with \`-disableFailureReports -resetState\`.
2. Tap "Start the gift finder" → Recipient: Partner → any interests (e.g. Everyday Style + Bags & Accessories)
   → Budget: $150 to $300 → Deadline: Pick up today → Continue.
3. Add the top pick to the bag, open the bag and tap "Reserve for pickup".
   Expected: the "It's in the works." confirmation with reservation code \`NORD-4028\`.
   Actual: "We couldn't complete your reservation." with an \`NORD-GF-…\` incident reference.
4. Repeat with Recipient: Mom — the reservation completes.

Steps:
1. This session is requested on macOS. Confirm with \`uname -s\` and \`xcodebuild -version\`: on macOS, do all
   the work here and do not create child sessions; only if this session is not on macOS (platform fallback),
   create one macOS child session for the simulator work.
2. Reproduce the failure as above and confirm the reported error.
3. Find the root cause of the missing fulfillment profile for the Partner recipient and fix it in the app's
   reservation configuration and/or lookup so Partner reservations complete like every other recipient. Do not
   swallow the error, skip the Partner recipient or hide the failure state.
4. Add or update XCTest coverage in \`${APP_DIR}/Tests/\` so a reservation succeeds for every recipient in
   \`GiftCatalog.recipients\` (the existing expectation that Partner fails must be removed or inverted), and run
   \`make test APP=nordstrom-gift-finder\` to green.
5. Keep the client identity (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}ios\`, \`POST ${IOS_ERROR_PATH}\`), the
   report payload shape and the failure-state UI unchanged. Re-run the Partner and Mom reproductions on the fix
   commit and record BEFORE/AFTER on the simulator.
6. Open a pull request against \`main\` of \`${APP_REPO_NAME}\`, request Devin Review, post findings back to the
   Slack thread, and stop for human approval before merging.

Reproduction safety: every failure report from the app raises a real Slack alert and Devin session. Always run
the app with \`NORDSTROM_DISABLE_FAILURE_REPORTS=1\` (\`SIMCTL_CHILD_\` prefix under \`simctl launch\`) or the
\`-disableFailureReports\` launch argument unless the alert chain is deliberately being exercised.`;

function clip(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function sanitizeContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => typeof entry === 'string' || typeof entry === 'number')
    .slice(0, 12)
    .map(([key, entry]) => [clip(key, 40), typeof entry === 'string' ? clip(entry, 256) : entry]));
}

function isAppSource(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return source.startsWith(APP_SOURCE_PREFIX);
}

function isAppReport(body) {
  return isAppSource(body)
    && body.service === APP_SERVICE
    && typeof body.errorType === 'string' && body.errorType.trim() !== ''
    && typeof body.recipient === 'string' && body.recipient.trim() !== '';
}

async function resolveUserIdByEmail(email, orgId) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !orgId) return '';
  try {
    const { apiKey } = getCustomerConfig(customerForOrg(orgId));
    const auth = apiKey ? { apiKey } : {};
    const members = await listOrgUsers(orgId, auth);
    const member = members.find((user) => (user.email || '').toLowerCase() === normalized);
    if (member) return member.user_id;
    const admins = await listEnterpriseAdmins(auth);
    const admin = admins.find((user) => (user.email || '').toLowerCase() === normalized);
    if (admin) return admin.user_id;
    logger.warn('Gift Finder iOS reporter email not found in org', { orgId });
  } catch (error) {
    logger.warn('Gift Finder iOS reporter lookup failed', { error: error.message, orgId });
  }
  return '';
}

function reportAppFailure(report) {
  const reference = uuidv4();
  const clientReference = clip(report.reference, 64);
  const platform = clip(report.platform || 'ios', 32);
  const screen = clip(report.screen || 'bag', 64);
  const action = clip(report.action || 'reserve_pickup', 64);
  const stage = clip(report.stage || APP_STAGE, 64);
  const recipient = clip(report.recipient, 32);
  const device = clip(report.device || 'iPhone', 64);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion, 32);
  const appName = clip(report.appName || 'Nordstrom Gift Finder', 64);
  const errorType = clip(report.errorType, 128);
  const errorMessage = clip(report.errorMessage || 'Final reservation failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const reproduction = clip(report.reproduction, 1000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const sentryEventId = clip(report.sentryEventId, 128);
  const context = sanitizeContext(report.context);
  const tags = {
    route: IOS_ERROR_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    stage,
    recipient,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('gift_finder.reservation.failure', {
    route: IOS_ERROR_PATH,
    errorClass: errorType,
    platform,
    screen,
    action,
    stage,
    recipient,
  });

  logger.error('Nordstrom Gift Finder iOS app reported a failure', {
    reference,
    clientReference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    stage,
    recipient,
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

  const extra = {
    reference,
    clientReference,
    release,
    environment,
    platform,
    screen,
    action,
    stage,
    recipient,
    device,
    osVersion,
    appVersion,
    appName,
    reproduction,
    sentryEventId: sentryEventId || null,
  };
  if (context !== undefined) extra.context = context;

  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST ${IOS_ERROR_PATH}`);
    Sentry.captureException(error, { tags, extra });
  });

  const customer = customerForOrg(report.devinOrgId);
  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=${encodeURIComponent(APP_SENTRY_ISSUE_QUERY)}`,
    culprit: APP_CULPRIT,
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail: report.devinEmail,
    devinOrgId: report.devinOrgId,
    service: APP_SERVICE,
    verticalLabel: 'Nordstrom — Black Friday Gift Finder (iOS)',
    customer,
    project: APP_PROJECT,
    release,
    sessionPlatform: GIFT_FINDER_IOS_SESSION_PLATFORM || undefined,
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      ...extra,
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

  const lookupOrgId = report.devinOrgId || getCustomerConfig(customer).devinOrgId || process.env.DEVIN_ORG_ID || '';
  const needsLookup = !report.devinUserId && report.devinEmail && lookupOrgId;
  const sessionPromise = (needsLookup
    ? resolveUserIdByEmail(report.devinEmail, lookupOrgId)
      .then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(report.devinUserId)
  ).catch((alertError) => {
    logger.error('Failed to create Devin session for Nordstrom Gift Finder iOS failure report', {
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
  APP_REPO_NAME,
  APP_DIR,
  APP_STAGE,
  IOS_ERROR_PATH,
  APP_SCENARIO,
  APP_CULPRIT,
  GIFT_FINDER_IOS_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  customerForOrg,
  isAppSource,
  isAppReport,
  reportAppFailure,
  resolveUserIdByEmail,
};
