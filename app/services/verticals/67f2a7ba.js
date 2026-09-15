const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * Citi consumer banking app (github.com/Custom-Devin-Demos/citi-banking-demo-app).
 *
 * The product surface is a Flutter codebase that ships three ways: the Citi
 * Online desktop site (hosted web build at /67f2a7ba/app), and the Citi
 * Mobile app for Android and iOS. The client resolves payments on-device,
 * reports failures to its own Sentry project, and also POSTs them to
 * /api/67f2a7ba/mobile/error so the Slack alert + Devin session are raised
 * under the mobile identity without a Sentry webhook round-trip.
 */
const CUSTOMER = '67f2a7ba';
const APP_SERVICE = `customer-${CUSTOMER}-mobile`;
const APP_PROJECT = 'citi-mobile';
const APP_RELEASE = 'citi-mobile@1.0.0';
const APP_SOURCE_PREFIX = 'citi-mobile/';
const APP_REPO = 'github.com/Custom-Devin-Demos/citi-banking-demo-app';
const APP_WEB_PATH = '/67f2a7ba/app';

/**
 * Scenario directive appended to the Devin investigation prompt. The alert
 * pipeline passes only a prompt to the Devin API, so the repository to
 * remediate and the surfaces to verify have to be named explicitly here.
 */
const APP_REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${APP_REPO}\` (Flutter)`,
  '',
  'This error was raised by the Citi consumer banking app, a Flutter codebase that ships as the',
  'Citi Online desktop website (web), and as the Citi Mobile app on Android and iOS, from one',
  'commit. Read `AGENTS.md` in that repo first.',
  '',
  'The failing code path is Pay My Citi Card:',
  '- Catalog: `lib/domain/card_products.dart` (card products a customer can hold)',
  '- Registry: `lib/domain/payment_posting.dart` (posting cutoff rule per product code)',
  '- Crash site: `lib/domain/payment_schedule.dart` (`buildPaymentSchedule`)',
  '- Entry: `lib/domain/payment_confirmation.dart` -> `lib/features/payments/pay_card_screen.dart`',
  '',
  `The alert came from the hosted web build at \`https://devindemos.com${APP_WEB_PATH}\` (served from`,
  '`app/public/verticals/67f2a7ba-app/` in `Custom-Devin-Demos/event-driven-devin`). The same commit',
  'ships natively, so the fix must be verified on web AND on Android AND on iOS.',
  '',
  'Steps:',
  '1. Reproduce on web first: run the Flutter repo `main` in Chrome (`flutter run -d chrome`, or',
  '   `flutter build web` served locally) at desktop width, sign on, and on the Account Summary click',
  '   Make Payment for the Citi Strata Elite card (or Payments & Transfers -> Pay My Citi Card), keep',
  '   the default card and click Make a Payment — confirm the "We couldn\'t complete your payment"',
  '   card. Note that `flutter test` is GREEN on the broken baseline: nothing asserts that every',
  '   product in the card catalog has a posting rule.',
  '2. Fix the data, not just the crash site: register the missing product in `paymentPostingRules`',
  '   with an accurate rule and make `buildPaymentSchedule` tolerate an unregistered product',
  '   (documented default or `PaymentValidationException`) instead of null-asserting it.',
  '3. Add the prevention control: a `test/domain/payment_posting_test.dart` test asserting every code',
  '   in `cardProductCatalog` has a `paymentPostingRules` entry, a `buildPaymentConfirmation` test for',
  '   the Strata Elite card, and coverage for the tolerant path. `flutter analyze --fatal-infos` and',
  '   `flutter test` must pass.',
  `   Do not change \`AppConfig.serviceName\` (\`${APP_SERVICE}\`), \`DevinIdentity\`, or the telemetry tag set.`,
  '4. Re-run the web reproduction on the fix commit and confirm the "Payment scheduled" confirmation',
  '   for the Strata Elite card, on both the desktop layout and a phone-width viewport.',
  '5. Open a pull request against `main`, request Devin Review, and STOP for human approval.',
  '6. After approval, spawn SEPARATE child sessions for Android (Linux VM with an emulator) and iOS',
  '   (macOS VM with the Xcode simulator). Each checks out the same fix commit SHA, runs',
  '   `scripts/verify-native.sh android` / `scripts/verify-native.sh ios` with `RECORD=1` (build +',
  '   `integration_test/make_payment_test.dart` driving the real mobile UI), and posts the recording',
  '   showing a scheduled payment plus the verified commit SHA to the PR.',
  '7. Confirm web, Android and iOS all verified the SAME commit SHA before merge.',
  `8. Refresh the hosted web build: \`flutter build web --release --base-href ${APP_WEB_PATH}/\` on the`,
  '   fix commit, copy `build/web/` into `app/public/verticals/67f2a7ba-app/` in',
  '   `Custom-Devin-Demos/event-driven-devin`, delete the copied `canvaskit/` directory, and open a',
  `   PR there so the deployed site at \`${APP_WEB_PATH}\` picks up the fix.`,
].join('\n');

function clip(value, max) {
  const text = value == null ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** Keep only flat scalar payment metadata so Sentry/Slack payloads stay bounded. */
function sanitizePayment(payment) {
  if (!payment || typeof payment !== 'object' || Array.isArray(payment)) return {};
  const out = {};
  for (const [key, value] of Object.entries(payment)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[clip(key, 64)] = typeof value === 'string' ? clip(value, 256) : value;
    }
  }
  return out;
}

/** True when a request body comes from the Citi client (any platform). */
function isAppSource(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return source.startsWith(APP_SOURCE_PREFIX);
}

/** True when a request body carries the Citi mobile identity. */
function isAppReport(body) {
  return isAppSource(body) && body.service === APP_SERVICE;
}

/**
 * Resolve the reporting user inside the Citi org from the email the hub (or the
 * native sign-on) supplied, when the client could not supply a user id itself.
 * Returns '' when nobody matches so the caller falls back to the customer config.
 * The lookup authenticates with the Citi service key: the default enterprise key
 * is not a member of the Citi org and the members endpoint rejects it.
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
    logger.warn('Citi mobile reporter email not found in org', { orgId });
  } catch (err) {
    logger.warn('Citi mobile reporter lookup failed', { error: err.message, orgId });
  }
  return '';
}

/**
 * Bridge a failure reported by the Citi Flutter client (web, Android or iOS)
 * into the Slack alert + Devin session flow under the mobile identity.
 * The client has already rendered its error card; this is telemetry only.
 */
function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'web', 32);
  const screen = clip(report.screen || 'pay_card', 64);
  const action = clip(report.action || 'make_payment', 64);
  const product = clip(report.product || 'unknown', 64);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Payment request failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const payment = sanitizePayment(report.payment);

  const tags = {
    route: '/api/67f2a7ba/mobile/error',
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    product,
    scenario: 'pay-citi-card',
  };

  incrementMetric('mobile_payment.failure', {
    route: '/api/67f2a7ba/mobile/error',
    errorClass: errorType,
    platform,
    product,
  });

  logger.error('Citi mobile app reported a failure', {
    reference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    product,
    errorClass: errorType,
    error: errorMessage,
    sentryEventId: report.sentryEventId || null,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  Sentry.captureException(error, {
    tags,
    extra: { reference, release, environment, payment, sentryEventId: report.sentryEventId },
  });

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=is%3Aunresolved`,
    culprit: 'lib/domain/payment_schedule.dart \u2014 buildPaymentSchedule',
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail: report.devinEmail,
    devinOrgId: report.devinOrgId,
    service: APP_SERVICE,
    verticalLabel: 'Citi Mobile',
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference,
      stackTrace,
      sentryEventId: report.sentryEventId || null,
      payment,
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
    logger.error('Failed to create Devin session for Citi mobile failure report', {
      error: err.message,
      reference,
    });
  });

  return { reference, sessionPromise };
}

/**
 * Acknowledge a payment the client already scheduled on-device. The client is
 * the system of record for the demo; this is registration only.
 */
function registerPayment(payment) {
  const confirmationNumber = clip(payment.confirmationNumber, 64) || uuidv4();
  incrementMetric('mobile_payment.success', {
    route: '/api/67f2a7ba/payments',
    platform: clip(String(payment.source || '').replace(APP_SOURCE_PREFIX, ''), 32) || 'web',
    product: clip(payment.product || 'unknown', 64),
  });
  logger.info('Citi mobile payment registered', {
    confirmationNumber,
    service: APP_SERVICE,
    product: payment.product,
    amount: payment.amount,
  });
  return {
    success: true,
    confirmationNumber,
    status: 'registered',
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
  isAppReport,
  isAppSource,
  reportAppFailure,
  registerPayment,
};
