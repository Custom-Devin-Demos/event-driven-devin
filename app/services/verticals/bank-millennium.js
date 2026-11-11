const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER = 'bf98154e';
const APP_SERVICE = 'customer-bank-millennium';
const APP_PROJECT = 'bank-millennium';
const APP_VERSION = '2026.4.2';
const APP_SOURCE_PREFIX = 'bank-millennium/';
const APP_PLATFORMS = ['web', 'ios', 'windows'];
const PLATFORM_LABELS = { web: 'web', ios: 'iOS', windows: 'Windows' };
const REPORT_PATH = '/api/bankmillennium/login/error';
const APP_SCENARIO = 'millenet-login-sign-in-policy';
const ERROR_CODE = 'MIL-AUTH-4031';
const IOS_REPO = 'COG-GTM/event-driven-ios';
const WEB_REPO = 'COG-GTM/event-driven-devin';
const WINDOWS_DIR = 'windows/BankMillennium';
const WEB_PAGE = 'app/public/verticals/bf98154e.html';
const WEB_TEST = 'tests/bf98154e-bank-millennium.test.js';
const APP_CULPRIT = 'SignInPolicies.policyFor — Millenet sign-in policy lookup (BankMillenniumCore/SignInPolicies.swift, BankMillennium.Core/SignInPolicies.cs + web)';
// The orchestrator only diagnoses and delegates: the iOS child needs Xcode + the
// iOS Simulator (macOS), the Windows child needs .NET 8 + WPF (Windows) and the
// web child needs Node + a browser (Linux).
const BANK_MILLENNIUM_SESSION_PLATFORM = process.env.BANK_MILLENNIUM_SESSION_PLATFORM === undefined
  ? 'linux'
  : process.env.BANK_MILLENNIUM_SESSION_PLATFORM;
const BANK_MILLENNIUM_SLACK_MEMBER_ID = process.env.BANK_MILLENNIUM_SLACK_MEMBER_ID || '';

const APP_REMEDIATION_DIRECTIVE = `*Repositories:* \`github.com/${IOS_REPO}\` (Swift / SwiftUI, native iOS) and \`github.com/${WEB_REPO}\` (web client + the Windows desktop app under \`${WINDOWS_DIR}/\`)

This alert came from the Bank Millennium Millenet login (https://www.bankmillennium.pl/, Polish). The same
client ships on three platforms that each carry their own copy of the sign-in policy table (keyed by customer segment,
used by the login step after the identity service resolves the customer):
- iOS: \`${IOS_REPO}\`, folders \`BankMillenniumCore/\` (Foundation-only rules, \`SignInPolicies.swift\`) and \`BankMillenniumMobile/\` (SwiftUI)
- Windows: \`${WEB_REPO}\`, \`${WINDOWS_DIR}/\` (\`BankMillennium.Core/SignInPolicies.cs\`, WPF app \`BankMillennium.Desktop\`); read its \`README.md\`
- Web: \`${WEB_REPO}\`, \`${WEB_PAGE}\` (the \`SIGN_IN_POLICIES\` block), served at \`/bankmillennium\`

Failing path on all three: Logowanie do Millenetu -> Millekod 48213907 (Anna Kowalska) -> DALEJ -> Hasło -> *ZALOGUJ*
fails with \`${ERROR_CODE}\`. Millekod 31570264 (Standard) and 55018342 (Private Banking) log in normally.

You are the ORCHESTRATOR for this incident. Do not edit, build or run any app yourself.
0. FIRST, before reading any code: reply in the alert's Slack thread (channel and thread_ts are at the end of this
   prompt; \`curl\` \`chat.postMessage\` with \`$SLACK_BOT_TOKEN\`) with your Devin session link and nothing else, e.g.
   ":robot_face: Investigating — <your session URL>". Do this even if the alert already shows a "View in Devin" button.
   Treat this alert as a new incident even if the same error has alerted before: do not look for, wait on, reuse or link
   earlier alerts, Slack threads, Devin sessions, branches or PRs for it. Run the full workflow below and open new PRs.
1. Diagnose read-only: open the sign-in policy lookup in all three clients and state the root cause (why this customer
   has no sign-in policy). README files describe the symptom, not the cause.
2. Because the defect lives in rules all three clients carry, create THREE child Devin sessions in parallel and give each
   the diagnosis:
   - a *macOS* child for \`${IOS_REPO}\` (\`BankMillenniumCore/\`, \`BankMillenniumMobile/\` only): needs Xcode + the iOS Simulator.
     \`swift test --package-path BankMillenniumCore\`, \`make test-millennium\`, repro with \`make run-millennium\`
     (sets \`BM_DISABLE_FAILURE_REPORTS=1\`).
   - a *Windows* child for \`${WEB_REPO}\` (\`${WINDOWS_DIR}/\` only): needs the .NET 8 SDK + WPF (install the SDK if it is missing).
     \`dotnet test ${WINDOWS_DIR}/BankMillennium.Core.Tests\`, repro with
     \`$env:BM_DISABLE_FAILURE_REPORTS=1; dotnet run --project ${WINDOWS_DIR}/BankMillennium.Desktop\`.
   - a *Linux* child for \`${WEB_REPO}\` (\`${WEB_PAGE}\` and \`${WEB_TEST}\` only): \`npx jest ${WEB_TEST}\`,
     repro in a browser at \`http://localhost:<port>/bankmillennium?reports=off\`.
3. Each child must: reproduce with failure reports off; fix the root cause in its sign-in policy table (do not swallow the
   error, default unknown segments to a policy, or hide the red error state); add a regression test that fails before and
   passes after; keep the client identity (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}<web|ios|windows>\`,
   \`POST ${REPORT_PATH}\`) and payload shape unchanged; record BEFORE/AFTER (video + screenshots of the same login);
   open a *draft* PR against \`main\` with a normal conventional title (e.g. \`fix(bank-millennium): ...\`), and report
   the PR link and test output.
4. Wait for all three children, review all three PRs (the iOS, Windows and web fixes must be equivalent and each must carry
   a regression test), send corrections back to the owning child, then post a summary with all three PR links to the
   Slack thread.
Never merge: the PRs go to human review.

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
  const screen = clip(report.screen || 'Login', 64);
  const action = clip(report.action || 'signIn', 64);
  const millekodMasked = clip(report.millekodMasked || 'unknown', 16);
  const segment = clip(report.segment || 'unknown', 64);
  const channel = clip(report.channel || platform, 16);
  const policyVersion = clip(report.policyVersion || 'unknown', 16);
  const errorCode = clip(report.errorCode || ERROR_CODE, 32);
  const device = clip(report.device || (platform === 'ios' ? 'iPhone' : platform), 64);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion || APP_VERSION, 32);
  const errorType = clip(report.errorType || 'SignInPolicyError', 128);
  const errorMessage = clip(report.errorMessage || 'Login failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || `bank-millennium-${platform}@${APP_VERSION}`, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const details = {
    platform, screen, action, millekodMasked, segment, channel, policyVersion, errorCode, device, osVersion, appVersion,
  };
  const tags = {
    route: REPORT_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    segment,
    error_code: errorCode,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('bank_millennium.login.failure', {
    route: REPORT_PATH, errorClass: errorType, platform, screen, action, segment,
  });

  logger.error('Bank Millennium client reported a login failure', {
    reference, service: APP_SERVICE, ...details, errorClass: errorType, error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  error.stack = `${errorType}: ${errorMessage}\n    at SignInPolicies.policyFor (${APP_SOURCE_PREFIX}${platform}/${screen}/${action}:1:1)`;

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
    slackMemberId: report.devinEmail ? '' : BANK_MILLENNIUM_SLACK_MEMBER_ID,
    slackMemberIdFallback: BANK_MILLENNIUM_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: `Bank Millennium — Millenet login (${PLATFORM_LABELS[platform] || 'web'})`,
    customer: CUSTOMER,
    project: APP_PROJECT,
    release,
    title: `[Bank Millennium] ${errorCode} login failed for segment ${segment} (${platform})`,
    sessionPlatform: BANK_MILLENNIUM_SESSION_PLATFORM || undefined,
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
    logger.error('Failed to create Devin session for Bank Millennium login failure report', {
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
  WEB_PAGE,
  WEB_TEST,
  PLATFORM_LABELS,
  BANK_MILLENNIUM_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  platformOf,
  isAppReport,
  reportAppFailure,
};
