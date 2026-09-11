const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * Nordstrom shopping app (github.com/Custom-Devin-Demos/nordstrom-shopping-demo-app).
 *
 * The product surface is a Flutter codebase that ships three ways: the
 * nordstrom.com desktop site (hosted web build at /5b7227b4/app), and the
 * Nordstrom app for Android and iOS. The client prices the bag on-device,
 * reports failures to its own Sentry project, and also POSTs them to
 * /api/5b7227b4/mobile/error so the Slack alert + Devin session are raised
 * under the app identity without a Sentry webhook round-trip.
 */
const CUSTOMER = '5b7227b4';
const APP_SERVICE = `customer-${CUSTOMER}-mobile`;
const APP_PROJECT = 'nordstrom-shop';
const APP_RELEASE = 'nordstrom-shop@1.0.0';
const APP_SOURCE_PREFIX = 'nordstrom-shop/';
const APP_REPO = 'github.com/Custom-Devin-Demos/nordstrom-shopping-demo-app';
const APP_WEB_PATH = '/5b7227b4/app';
const SCENARIO = 'add-to-bag-rewards';

/**
 * Scenario directive appended to the Devin investigation prompt. The alert
 * pipeline passes only a prompt to the Devin API, so the repository to
 * remediate and the surfaces to verify have to be named explicitly here.
 */
const APP_REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${APP_REPO}\` (Flutter)`,
  '',
  'This error was raised by the Nordstrom shopping app, a Flutter codebase that ships as the',
  'nordstrom.com desktop website (web) and as the Nordstrom app on Android and iOS, from one',
  'commit. Read `AGENTS.md` in that repo first.',
  '',
  'The failing code path is Add to Bag:',
  '- Catalog: `lib/domain/catalog.dart` (products and their `PriceStatus`)',
  '- Registry: `lib/domain/rewards_earning.dart` (Nordy Club earning rule per price status)',
  '- Crash site: `lib/domain/bag_summary.dart` (`buildBagSummary` -> `_rewardsForLine`)',
  '- Entry: `lib/features/bag/bag_provider.dart` (`AddToBagFlow.run`) <- `lib/features/product/product_screen.dart`',
  '',
  `The alert came from the hosted web build at \`https://devindemos.com${APP_WEB_PATH}\` (served from`,
  '`app/public/verticals/5b7227b4-app/` in `Custom-Devin-Demos/event-driven-devin`). The same commit',
  'ships natively, so the fix must be verified on web AND on Android AND on iOS.',
  '',
  'Steps:',
  '1. Reproduce on web first: run the Flutter repo `main` in Chrome (`flutter run -d chrome`, or',
  '   `flutter build web` served locally) at desktop width, open a product tagged "New Markdown" from',
  '   the homepage rail, pick a size, and click Add to Bag — confirm the "We couldn\'t add this item to',
  '   your bag" message and the incident toast. Note that `flutter test` is GREEN on the broken',
  '   baseline: nothing asserts that every `PriceStatus` a product can carry has an earning rule.',
  '2. Fix the data, not just the crash site: register the missing price status in',
  '   `nordyClubEarningRules` with an accurate rule and make `buildBagSummary` tolerate an unregistered',
  '   status (documented default or `BagValidationException`) instead of null-asserting it.',
  '3. Add the prevention control: a `test/domain/rewards_earning_test.dart` test asserting every',
  '   `PriceStatus` value has a `nordyClubEarningRules` entry, a `buildBagSummary` test for a New',
  '   Markdown line, and coverage for the tolerant path. `flutter analyze --fatal-infos` and',
  '   `flutter test` must pass.',
  `   Do not change \`AppConfig.serviceName\` (\`${APP_SERVICE}\`), \`DevinIdentity\`, or the telemetry tag set.`,
  '4. Re-run the web reproduction on the fix commit and confirm the "Added to your bag" sheet for the',
  '   New Markdown item, on both the desktop layout and a phone-width viewport.',
  '5. Open a pull request against `main`, request Devin Review, and STOP for human approval.',
  '6. After approval, spawn SEPARATE child sessions for Android (Linux VM with an emulator) and iOS',
  '   (macOS VM with the Xcode simulator). Each checks out the same fix commit SHA, runs',
  '   `scripts/verify-native.sh android` / `scripts/verify-native.sh ios` with `RECORD=1` (build +',
  '   `integration_test/add_to_bag_test.dart` driving the real mobile UI), and posts the recording',
  '   showing the item added to the bag plus the verified commit SHA to the PR.',
  '7. Confirm web, Android and iOS all verified the SAME commit SHA before merge.',
  `8. Refresh the hosted web build: \`flutter build web --release --base-href ${APP_WEB_PATH}/\` on the`,
  '   fix commit, copy `build/web/` into `app/public/verticals/5b7227b4-app/` in',
  '   `Custom-Devin-Demos/event-driven-devin`, delete the copied `canvaskit/` directory, and open a',
  `   PR there so the deployed site at \`${APP_WEB_PATH}\` picks up the fix.`,
].join('\n');

function clip(value, max) {
  const text = value == null ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** Keep only flat scalar bag metadata so Sentry/Slack payloads stay bounded. */
function sanitizeBag(bag) {
  if (!bag || typeof bag !== 'object' || Array.isArray(bag)) return {};
  const out = {};
  for (const [key, value] of Object.entries(bag)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[clip(key, 64)] = typeof value === 'string' ? clip(value, 256) : value;
    }
  }
  return out;
}

/** True when a request body comes from the Nordstrom client (any platform). */
function isAppSource(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return source.startsWith(APP_SOURCE_PREFIX);
}

/** True when a request body carries the Nordstrom app identity. */
function isAppReport(body) {
  return isAppSource(body) && body.service === APP_SERVICE;
}

/**
 * Resolve the reporting user inside the Nordstrom org from the email the hub
 * (or the native sign-in) supplied, when the client could not supply a user id
 * itself. Returns '' when nobody matches so the caller falls back to the
 * customer config. The lookup authenticates with the Nordstrom service key:
 * the default enterprise key is not a member of the Nordstrom org and the
 * members endpoint rejects it.
 */
async function resolveUserIdByEmail(email, orgId) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !orgId) return '';
  try {
    const { apiKey } = getCustomerConfig(CUSTOMER);
    const auth = apiKey ? { apiKey } : {};
    const members = await listOrgUsers(orgId, auth);
    const member = members.find((u) => (u.email || '').toLowerCase() === normalized);
    if (member) return member.user_id;
    const admins = await listEnterpriseAdmins(auth);
    const admin = admins.find((u) => (u.email || '').toLowerCase() === normalized);
    if (admin) return admin.user_id;
    logger.warn('Nordstrom app reporter email not found in org', { orgId });
  } catch (err) {
    logger.warn('Nordstrom app reporter lookup failed', { error: err.message, orgId });
  }
  return '';
}

/**
 * Bridge a failure reported by the Nordstrom Flutter client (web, Android or
 * iOS) into the Slack alert + Devin session flow under the app identity.
 * The client has already rendered its error message; this is telemetry only.
 */
function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'web', 32);
  const screen = clip(report.screen || 'product', 64);
  const action = clip(report.action || 'add_to_bag', 64);
  const product = clip(report.product || 'unknown', 64);
  const priceStatus = clip(report.priceStatus || 'unknown', 32);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Add to Bag failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const bag = sanitizeBag(report.bag);

  const tags = {
    route: '/api/5b7227b4/mobile/error',
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    product,
    price_status: priceStatus,
    scenario: SCENARIO,
  };

  incrementMetric('add_to_bag.failure', {
    route: '/api/5b7227b4/mobile/error',
    errorClass: errorType,
    platform,
    product,
    priceStatus,
  });

  logger.error('Nordstrom app reported a failure', {
    reference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    product,
    priceStatus,
    errorClass: errorType,
    error: errorMessage,
    sentryEventId: report.sentryEventId || null,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  Sentry.captureException(error, {
    tags,
    extra: { reference, release, environment, bag, sentryEventId: report.sentryEventId },
  });

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=is%3Aunresolved`,
    culprit: 'lib/domain/bag_summary.dart \u2014 buildBagSummary',
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail: report.devinEmail,
    devinOrgId: report.devinOrgId,
    service: APP_SERVICE,
    verticalLabel: 'Nordstrom',
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference,
      stackTrace,
      sentryEventId: report.sentryEventId || null,
      bag,
    },
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

  const needsLookup = !report.devinUserId && report.devinEmail && report.devinOrgId;
  const sessionPromise = (needsLookup
    ? resolveUserIdByEmail(report.devinEmail, report.devinOrgId)
      .then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(report.devinUserId)
  ).catch((err) => {
    logger.error('Failed to create Devin session for Nordstrom app failure report', {
      error: err.message,
      reference,
    });
  });

  return { reference, sessionPromise };
}

/**
 * Acknowledge a bag the client already priced on-device. The client is the
 * system of record for the demo; this is registration only.
 */
function registerBag(bag) {
  const bagId = clip(bag.bagId, 64) || uuidv4();
  incrementMetric('add_to_bag.success', {
    route: '/api/5b7227b4/bag',
    platform: clip(String(bag.source || '').replace(APP_SOURCE_PREFIX, ''), 32) || 'web',
    product: clip(bag.product || 'unknown', 64),
  });
  logger.info('Nordstrom bag synced', {
    bagId,
    service: APP_SERVICE,
    product: bag.product,
    itemCount: bag.itemCount,
    total: bag.total,
    nordyPoints: bag.nordyPoints,
  });
  return {
    success: true,
    bagId,
    status: 'synced',
    receivedAt: new Date().toISOString(),
  };
}

module.exports = {
  APP_SERVICE,
  APP_PROJECT,
  APP_RELEASE,
  APP_SOURCE_PREFIX,
  APP_REPO,
  APP_WEB_PATH,
  APP_REMEDIATION_DIRECTIVE,
  SCENARIO,
  isAppReport,
  isAppSource,
  reportAppFailure,
  registerBag,
};
