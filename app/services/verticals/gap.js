const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER = '1c2b9bcc';
const APP_SERVICE = 'customer-gap';
const APP_PROJECT = 'gap-storefront';
const APP_VERSION = '2026.11.0';
const APP_SOURCE_PREFIX = 'gap/';
const APP_PLATFORMS = ['web', 'ios', 'android'];
const PLATFORM_LABELS = { web: 'web', ios: 'iOS', android: 'Android' };
const REPORT_PATH = '/api/gap/pdp/error';
const APP_SCENARIO = 'gap-holiday-pdp-size-chart';
const ERROR_CODE = 'GAP-PDP-4041';
const IOS_REPO = 'COG-GTM/event-driven-ios';
const ANDROID_REPO = 'COG-GTM/android-demos';
const WEB_REPO = 'COG-GTM/event-driven-devin';
const ANDROID_DIR = `apps/${CUSTOMER}`;
const WEB_PAGE = `app/public/verticals/${CUSTOMER}.html`;
const WEB_TEST = `tests/${CUSTOMER}-gap-holiday.test.js`;
const APP_CULPRIT = 'SizeCharts.chartFor — product page size chart lookup (GapCore/SizeCharts.swift, SizeCharts.kt + web)';
// The orchestrator only diagnoses and delegates: the iOS child needs Xcode + the
// iOS Simulator (macOS); the Android child (Android SDK + emulator) and the web
// child (Node + a browser) run on Linux.
const GAP_SESSION_PLATFORM = process.env.GAP_SESSION_PLATFORM === undefined
  ? 'linux'
  : process.env.GAP_SESSION_PLATFORM;
const GAP_SLACK_MEMBER_ID = process.env.GAP_SLACK_MEMBER_ID || '';

const APP_REMEDIATION_DIRECTIVE = `*Repositories:* \`github.com/${IOS_REPO}\` (Swift / SwiftUI, native iOS), \`github.com/${ANDROID_REPO}\` (Kotlin / Jetpack Compose, native Android) and \`github.com/${WEB_REPO}\` (gap.com web client)

This alert came from the Gap storefront (https://www.gap.com/). The same shopping client ships on three platforms that
each carry their own copy of the size chart table (keyed by the catalog's \`sizeChartCode\`, used by the product page to
build the size picker and the Size & Fit guide):
- iOS: \`${IOS_REPO}\`, folders \`GapCore/\` (Foundation-only rules, \`SizeCharts.swift\`) and \`GapMobile/\` (SwiftUI)
- Android: \`${ANDROID_REPO}\`, module \`${ANDROID_DIR}/\` (\`SizeCharts.kt\`, Compose UI); read its \`README.md\`
- Web: \`${WEB_REPO}\`, \`${WEB_PAGE}\` (the \`SIZE_CHARTS\` block), served at \`/gap-holiday\`

Failing path on all three: Home -> *The Holiday Collection* -> *CashSoft Rib Quarter-Zip Sweater* (pid 914524042)
fails with \`${ERROR_CODE}\` instead of opening the product page. Every other Holiday Collection product (e.g. CashSoft
Crew Sweater 908887122, 100% Cotton Relaxed Quarter-Zip Sweater 908078012) opens and adds to bag normally.

You are the ORCHESTRATOR for this incident. Do not edit, build or run any app yourself.
0. FIRST, before reading any code: reply in the alert's Slack thread (channel and thread_ts are at the end of this
   prompt; \`curl\` \`chat.postMessage\` with \`$SLACK_BOT_TOKEN\`) with your Devin session link and nothing else, e.g.
   ":robot_face: Investigating — <your session URL>". Do this even if the alert already shows a "View in Devin" button.
   Treat this alert as a new incident even if the same error has alerted before: do not look for, wait on, reuse or link
   earlier alerts, Slack threads, Devin sessions, branches or PRs for it. Run the full workflow below and open new PRs.
1. Diagnose read-only: open the size chart lookup in all three clients and state the root cause (why this product has
   no size chart). README files describe the symptom, not the cause.
2. Because the defect lives in rules all three clients carry, create THREE child Devin sessions in parallel and give each
   the diagnosis:
   - a *macOS* child for \`${IOS_REPO}\` (\`GapCore/\`, \`GapMobile/\` only): needs Xcode + the iOS Simulator.
     \`swift test --package-path GapCore\`, \`make test-gap\`, repro with \`make run-gap\`
     (sets \`GAP_DISABLE_FAILURE_REPORTS=1\`).
   - a *Linux* child for \`${ANDROID_REPO}\` (\`${ANDROID_DIR}/\` only): needs JDK 17 + the Android SDK/emulator.
     \`make test APP=${CUSTOMER}\`, \`make build APP=${CUSTOMER}\`, repro on the emulator with \`make run APP=${CUSTOMER}\`
     (debug builds ship with failure reports off).
   - a *Linux* child for \`${WEB_REPO}\` (\`${WEB_PAGE}\` and \`${WEB_TEST}\` only): \`npx jest ${WEB_TEST}\`,
     repro in a browser at \`http://localhost:<port>/gap-holiday?reports=off\`.
3. Each child must: reproduce with failure reports off; fix the root cause in its size chart table (do not swallow the
   error, fall back to a default chart for unknown codes, or hide the red error state); add a regression test that fails
   before and passes after; keep the client identity (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}<web|ios|android>\`,
   \`POST ${REPORT_PATH}\`) and payload shape unchanged; record BEFORE/AFTER (video + screenshots of the same flow);
   open a *draft* PR against \`main\` with a normal conventional title (e.g. \`fix(gap): ...\`), and report the PR link and
   test output.
4. Wait for all three children, review all three PRs (the iOS, Android and web fixes must be equivalent and each must
   carry a regression test), send corrections back to the owning child, then post a summary with all three PR links to
   the Slack thread.
Never merge: the PRs go to human review.

Reproduction safety: every failure report raises a real Slack alert and Devin session. Never run the iOS or Android app
with failure reports on, and always open the web page with \`?reports=off\`.`;

function clip(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function platformOf(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  if (!source.startsWith(APP_SOURCE_PREFIX)) return '';
  const platform = source.slice(APP_SOURCE_PREFIX.length);
  return APP_PLATFORMS.includes(platform) ? platform : '';
}

function isAppReport(body) {
  return Boolean(platformOf(body)) && body.service === APP_SERVICE;
}

function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = platformOf(report) || 'unknown';
  const screen = clip(report.screen || 'ProductPage', 64);
  const action = clip(report.action || 'openProduct', 64);
  const productId = clip(report.productId || 'unknown', 32);
  const productName = clip(report.productName || 'unknown', 128);
  const sizeChartCode = clip(report.sizeChartCode || 'unknown', 64);
  const category = clip(report.category || 'unknown', 64);
  const catalogVersion = clip(report.catalogVersion || 'unknown', 32);
  const errorCode = clip(report.errorCode || ERROR_CODE, 32);
  const device = clip(report.device || platform, 64);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion || APP_VERSION, 32);
  const errorType = clip(report.errorType || 'SizeChartError', 128);
  const errorMessage = clip(report.errorMessage || 'Product page failed to load', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || `gap-${platform}@${APP_VERSION}`, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const details = {
    platform, screen, action, productId, productName, sizeChartCode, category, catalogVersion, errorCode, device, osVersion, appVersion,
  };
  const tags = {
    route: REPORT_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    product_id: productId,
    size_chart: sizeChartCode,
    error_code: errorCode,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('gap.pdp.failure', {
    route: REPORT_PATH, errorClass: errorType, platform, screen, action, productId,
  });

  logger.error('Gap client reported a product page failure', {
    reference, service: APP_SERVICE, ...details, errorClass: errorType, error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  error.stack = `${errorType}: ${errorMessage}\n    at SizeCharts.chartFor (${APP_SOURCE_PREFIX}${platform}/${screen}/${action}:1:1)`;

  Sentry.withScope((scope) => {
    scope.setTransactionName(`${APP_SOURCE_PREFIX}${platform} ${screen} ${action}`);
    scope.addEventProcessor((event) => ({ ...event, release, environment }));
    Sentry.captureException(error, {
      tags,
      extra: {
        reference, release, environment, ...details, errorType, errorMessage, stackTrace,
      },
    });
  });

  const sessionPromise = Promise.resolve(createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(`is:unresolved error_code:${errorCode}`)}`,
    culprit: APP_CULPRIT,
    errorType,
    errorValue: errorMessage,
    devinUserId: report.devinUserId || undefined,
    devinEmail: report.devinEmail,
    devinOrgId: report.devinOrgId || undefined,
    slackMemberId: report.devinEmail ? '' : GAP_SLACK_MEMBER_ID,
    slackMemberIdFallback: GAP_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: `Gap — Holiday Collection product page (${PLATFORM_LABELS[platform] || 'web'})`,
    customer: CUSTOMER,
    project: APP_PROJECT,
    release,
    title: `[Gap] ${errorCode} product page failed for ${productName} ${productId} (${platform})`,
    sessionPlatform: GAP_SESSION_PLATFORM || undefined,
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    skipVulnerablePr: true,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference, ...details, stackTrace, reporterEmail: clip(report.devinEmail, 128),
    },
    level: 'error',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    environment,
    triggeredRule: '',
  })).catch((alertError) => {
    logger.error('Failed to create Devin session for Gap product page failure report', {
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
  APP_VERSION,
  APP_SOURCE_PREFIX,
  APP_PLATFORMS,
  REPORT_PATH,
  APP_SCENARIO,
  APP_CULPRIT,
  ERROR_CODE,
  IOS_REPO,
  ANDROID_REPO,
  WEB_REPO,
  ANDROID_DIR,
  WEB_PAGE,
  WEB_TEST,
  PLATFORM_LABELS,
  GAP_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  platformOf,
  isAppReport,
  reportAppFailure,
};
