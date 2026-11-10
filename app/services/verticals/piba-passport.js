const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER = 'b09e76ca';
const APP_SERVICE = 'customer-piba-passport';
const APP_PROJECT = 'piba-passport';
const APP_VERSION = '2026.1.4';
const APP_SOURCE_PREFIX = 'piba-passport/';
const APP_PLATFORMS = ['web', 'ios', 'windows'];
const PLATFORM_LABELS = { web: 'web', ios: 'iOS', windows: 'Windows' };
const REPORT_PATH = '/api/piba/passport/error';
const APP_SCENARIO = 'passport-renewal-fee-schedule';
const ERROR_CODE = 'PIBA-FEE-4221';
const IOS_REPO = 'COG-GTM/event-driven-ios';
const WEB_REPO = 'COG-GTM/event-driven-devin';
const WINDOWS_DIR = 'windows/PibaPassport';
const WEB_PAGE = 'app/public/verticals/b09e76ca.html';
const WEB_TEST = 'tests/b09e76ca-piba-passport.test.js';
const APP_CULPRIT = 'FeeRules.buildPaymentOrder — 2026 fee schedule lookup (PibaPassportCore/FeeRules.swift, PibaPassport.Core/FeeRules.cs + web replica)';
// The orchestrator only diagnoses and delegates: the iOS child needs Xcode + the
// iOS Simulator (macOS), the Windows child needs .NET 8 + WPF (Windows) and the
// web child needs Node + a browser (Linux).
const PIBA_PASSPORT_SESSION_PLATFORM = process.env.PIBA_PASSPORT_SESSION_PLATFORM === undefined
  ? 'linux'
  : process.env.PIBA_PASSPORT_SESSION_PLATFORM;
const PIBA_PASSPORT_SLACK_MEMBER_ID = process.env.PIBA_PASSPORT_SLACK_MEMBER_ID || '';

const APP_REMEDIATION_DIRECTIVE = `*Repositories:* \`github.com/${IOS_REPO}\` (Swift / SwiftUI, native iOS) and \`github.com/${WEB_REPO}\` (web replica + the Windows desktop app under \`${WINDOWS_DIR}/\`)

This alert came from the Israel Population and Immigration Authority (רשות האוכלוסין וההגירה) biometric passport
appointment service, a replica of https://www.gov.il/he/service/application-for-biometric-passport-or-idcard. The same
client ships on three platforms that each carry their own copy of the fee rules (service catalogue + the fee schedule
effective 1.1.2026, used by the online fee payment step):
- iOS: \`${IOS_REPO}\`, folders \`PibaPassportCore/\` (Foundation-only rules, \`FeeRules.swift\`) and \`PibaPassportMobile/\` (SwiftUI, Hebrew RTL)
- Windows: \`${WEB_REPO}\`, \`${WINDOWS_DIR}/\` (\`PibaPassport.Core/FeeRules.cs\`, WPF app \`PibaPassport.Desktop\`); read its \`README.md\`
- Web: \`${WEB_REPO}\`, \`${WEB_PAGE}\` (the \`FEE_RULES\` block), served at \`/passport\`

Failing path on all three: דרכון ביומטרי (biometric passport) -> חידוש דרכון שפג תוקפו (renewal) -> age 18+ -> sign in ->
branch, date and time slot -> *לתשלום ואישור התור* (pay and confirm appointment) fails with \`${ERROR_CODE}\`. A first passport
and a lost/stolen passport pay and book normally.

You are the ORCHESTRATOR for this incident. Do not edit, build or run any app yourself.
1. Diagnose read-only: open the fee lookup in all three clients and state the root cause (why a passport renewal has no
   fee schedule entry). README files describe the symptom, not the cause.
2. Because the defect lives in rules all three clients carry, create THREE child Devin sessions in parallel and give each
   the diagnosis:
   - a *macOS* child for \`${IOS_REPO}\` (\`PibaPassportCore/\`, \`PibaPassportMobile/\` only): needs Xcode + the iOS Simulator.
     \`swift test --package-path PibaPassportCore\`, \`make test-piba\`, repro with \`make run-piba\`
     (sets \`PIBA_DISABLE_FAILURE_REPORTS=1\`).
   - a *Windows* child for \`${WEB_REPO}\` (\`${WINDOWS_DIR}/\` only): needs the .NET 8 SDK + WPF (install the SDK if it is missing).
     \`dotnet test ${WINDOWS_DIR}/PibaPassport.Core.Tests\`, repro with
     \`$env:PIBA_DISABLE_FAILURE_REPORTS=1; dotnet run --project ${WINDOWS_DIR}/PibaPassport.Desktop\`.
   - a *Linux* child for \`${WEB_REPO}\` (\`${WEB_PAGE}\` and \`${WEB_TEST}\` only): \`npx jest ${WEB_TEST}\`,
     repro in a browser at \`http://localhost:<port>/passport?reports=off\`.
3. Each child must: reproduce with failure reports off; fix the root cause in its fee rules (do not swallow the error,
   hard-code an amount, or hide the red error state); add a regression test that fails before and passes after; keep the
   client identity (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}<web|ios|windows>\`, \`POST ${REPORT_PATH}\`) and payload shape
   unchanged; record BEFORE/AFTER; open a *draft* PR against \`main\` with a normal conventional title
   (e.g. \`fix(passport): ...\`), and report the PR link and test output.
4. Wait for all three children, review all three PRs (the iOS, Windows and web fixes must be equivalent and each must carry
   a regression test), send corrections back to the owning child, then post a summary with all three PR links to the
   Slack thread.
Never merge: \`main\` keeps the planted defect so the demo can be re-run.

Reproduction safety: every failure report raises a real Slack alert and Devin session. Never run the iOS or Windows app
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
  const screen = clip(report.screen || 'Payment', 64);
  const action = clip(report.action || 'payAndConfirm', 64);
  const serviceCode = clip(report.serviceCode || 'unknown', 64);
  const documentType = clip(report.documentType || 'unknown', 32);
  const requestReason = clip(report.requestReason || 'unknown', 32);
  const ageBand = clip(report.ageBand || 'unknown', 16);
  const feeRate = clip(report.feeRate || 'unknown', 32);
  const feeSchedule = clip(report.feeSchedule || 'unknown', 32);
  const branch = clip(report.branch || 'unknown', 128);
  const appointment = clip(report.appointment || 'unknown', 64);
  const errorCode = clip(report.errorCode || ERROR_CODE, 32);
  const device = clip(report.device || (platform === 'ios' ? 'iPhone' : platform), 64);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion || APP_VERSION, 32);
  const errorType = clip(report.errorType || 'FeeScheduleError', 128);
  const errorMessage = clip(report.errorMessage || 'Fee payment failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || `piba-passport-${platform}@${APP_VERSION}`, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const details = {
    platform, screen, action, serviceCode, documentType, requestReason, ageBand, feeRate, feeSchedule, branch, appointment, errorCode, device, osVersion, appVersion,
  };
  const tags = {
    route: REPORT_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    service_code: serviceCode,
    error_code: errorCode,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('piba_passport.fee_payment.failure', {
    route: REPORT_PATH, errorClass: errorType, platform, screen, action, serviceCode,
  });

  logger.error('PIBA passport client reported a fee payment failure', {
    reference, service: APP_SERVICE, ...details, errorClass: errorType, error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  error.stack = `${errorType}: ${errorMessage}\n    at FeeRules.buildPaymentOrder (${APP_SOURCE_PREFIX}${platform}/${screen}/${action}:1:1)`;

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
    slackMemberId: report.devinEmail ? '' : PIBA_PASSPORT_SLACK_MEMBER_ID,
    slackMemberIdFallback: PIBA_PASSPORT_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: `gov.il Biometric passport — Fee payment (${PLATFORM_LABELS[platform] || 'web'})`,
    customer: CUSTOMER,
    project: APP_PROJECT,
    release,
    title: `[gov.il Passport] ${errorCode} fee payment failed for ${serviceCode} (${platform})`,
    sessionPlatform: PIBA_PASSPORT_SESSION_PLATFORM || undefined,
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
    logger.error('Failed to create Devin session for PIBA passport failure report', {
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
  IOS_ERROR_PATH: REPORT_PATH,
  REPORT_PATH,
  APP_SCENARIO,
  APP_CULPRIT,
  ERROR_CODE,
  IOS_REPO,
  WEB_REPO,
  WINDOWS_DIR,
  PIBA_PASSPORT_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  platformOf,
  isAppReport,
  reportAppFailure,
};
