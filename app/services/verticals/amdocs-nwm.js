const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER = 'b7e3a1d4';
const APP_SERVICE = 'customer-amdocs-nwm';
const APP_PROJECT = 'amdocs-nwm';
const APP_VERSION = '2.2.30';
const APP_SOURCE_PREFIX = 'amdocs-nwm/';
const APP_PLATFORMS = ['web', 'ios', 'android'];
const IOS_ERROR_PATH = '/api/amdocs/nwm/error';
const APP_SCENARIO = 'task-closeout-critical-priority';
const ERROR_CODE = 'NWM-WF-4221';
const IOS_REPO = 'COG-GTM/event-driven-ios';
const ANDROID_REPO = 'COG-GTM/android-demos';
const ANDROID_APP = 'apps/b7e3a1d4';
const WEB_REPO = 'COG-GTM/event-driven-devin';
const WEB_PAGE = 'app/public/verticals/b7e3a1d4.html';
const WEB_TEST = 'tests/b7e3a1d4-amdocs-nwm.test.js';
const APP_CULPRIT = 'TaskCloseout.complete(task:) — SLA close-out policy lookup (AmdocsNWMCore/WorkflowRules.swift + web replica)';
// The orchestrator only diagnoses and delegates: the iOS child needs Xcode + the
// iOS Simulator (macOS), the Android child needs the Android SDK + emulator
// (Linux) and the web child needs Node + a browser (Linux).
const AMDOCS_NWM_SESSION_PLATFORM = process.env.AMDOCS_NWM_SESSION_PLATFORM === undefined
  ? 'linux'
  : process.env.AMDOCS_NWM_SESSION_PLATFORM;
const AMDOCS_NWM_SLACK_MEMBER_ID = process.env.AMDOCS_NWM_SLACK_MEMBER_ID || '';

const APP_REMEDIATION_DIRECTIVE = `*Repositories:* \`github.com/${IOS_REPO}\` (Swift / SwiftUI, native iOS), \`github.com/${ANDROID_REPO}\` (Kotlin / Jetpack Compose, native Android) and \`github.com/${WEB_REPO}\` (web replica)

This alert came from Amdocs NWM (Network Workflow Management / TechInsights), the field-ops task app. The same
NWM client ships on three platforms that each carry their own copy of the shared workflow rules (the SLA close-out
policy table used by *Save & Complete*):
- iOS: \`${IOS_REPO}\`, folders \`AmdocsNWMCore/\` (Foundation-only rules, \`WorkflowRules.swift\`) and \`AmdocsNWMMobile/\` (SwiftUI)
- Android: \`${ANDROID_REPO}\`, \`${ANDROID_APP}/\` (\`core/Workflow.kt\` \`WorkflowRules\`, Compose UI); read its \`DEMO.md\`
- Web: \`${WEB_REPO}\`, \`${WEB_PAGE}\` (the \`WORKFLOW_RULES\` block), served at \`/amdocs\`

Failing path on all three: Projects -> TMO -> FCC Drive Test Check in -> ticket #716942 -> Validation task (priority
Critical) -> *Save & Complete* fails with \`${ERROR_CODE}\`. Tasks with other priorities complete normally.

You are the ORCHESTRATOR for this incident. Do not edit, build or run any app yourself.
1. Diagnose read-only: open the close-out policy lookup in all three clients and state the root cause (why a Critical
   task has no policy). DEMO docs describe the symptom, not the cause.
2. Because the defect lives in a dependency all three clients carry, create THREE child Devin sessions in parallel and give
   each the diagnosis:
   - a *macOS* child for \`${IOS_REPO}\` (\`AmdocsNWMCore/\`, \`AmdocsNWMMobile/\` only): needs Xcode + the iOS Simulator.
     \`swift test --package-path AmdocsNWMCore\`, \`make test-amdocs\`, repro with \`make run-amdocs\`
     (sets \`AMDOCS_DISABLE_FAILURE_REPORTS=1\`).
   - a *Linux* child for \`${ANDROID_REPO}\` (\`${ANDROID_APP}/\` only): needs the Android SDK + emulator.
     \`export JAVA_HOME=/usr/lib/jvm/java-17-openjdk-amd64\`, \`make test APP=b7e3a1d4\`, repro with \`make run APP=b7e3a1d4\`
     (reports stay off; never \`make demo\`).
   - a *Linux* child for \`${WEB_REPO}\` (\`${WEB_PAGE}\` and \`${WEB_TEST}\` only): \`npx jest ${WEB_TEST}\`,
     repro in a browser at \`http://localhost:<port>/amdocs?reports=off\`.
3. Each child must: reproduce with failure reports off; fix the root cause in its workflow rules (do not swallow the
   error, downgrade the task priority, or hide the red error state); add a regression test that fails before and
   passes after; keep the client identity (\`${APP_SERVICE}\`, \`${APP_SOURCE_PREFIX}<web|ios|android>\`, \`POST ${IOS_ERROR_PATH}\`)
   and payload shape unchanged; record BEFORE/AFTER; open a *draft* PR against \`main\` titled
   \`[DEMO — DO NOT MERGE] ...\`, and report the PR link and test output.
4. Wait for all three children, review all three PRs (the iOS, Android and web fixes must be equivalent and each must
   carry a regression test), send corrections back to the owning child, then post a summary with all three PR links
   to the Slack thread.
Never merge: \`main\` keeps the planted defect so the demo can be re-run.

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
  const screen = clip(report.screen || 'TaskDetail', 64);
  const action = clip(report.action || 'saveAndComplete', 64);
  const ticketId = clip(report.ticketId || 'unknown', 32);
  const taskId = clip(report.taskId || 'unknown', 32);
  const taskTitle = clip(report.taskTitle || 'unknown', 128);
  const priority = clip(report.priority || 'unknown', 32);
  const project = clip(report.project || 'unknown', 64);
  const workflow = clip(report.workflow || 'unknown', 128);
  const assignee = clip(report.assignee || 'unknown', 64);
  const errorCode = clip(report.errorCode || ERROR_CODE, 32);
  const device = clip(report.device || (platform === 'ios' ? 'iPhone' : 'web'), 64);
  const osVersion = clip(report.osVersion, 64);
  const appVersion = clip(report.appVersion || APP_VERSION, 32);
  const errorType = clip(report.errorType || 'WorkflowError', 128);
  const errorMessage = clip(report.errorMessage || 'Task close-out failed', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || `amdocs-nwm-${platform}@${APP_VERSION}`, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const details = {
    platform, screen, action, ticketId, taskId, taskTitle, priority, project, workflow, assignee, errorCode, device, osVersion, appVersion,
  };
  const tags = {
    route: IOS_ERROR_PATH,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    priority,
    error_code: errorCode,
    scenario: APP_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('amdocs_nwm.task_closeout.failure', {
    route: IOS_ERROR_PATH, errorClass: errorType, platform, screen, action, priority,
  });

  logger.error('Amdocs NWM app reported a task close-out failure', {
    reference, service: APP_SERVICE, ...details, errorClass: errorType, error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  error.stack = `${errorType}: ${errorMessage}\n    at TaskCloseout.complete (${APP_SOURCE_PREFIX}${platform}/${screen}/${action}:1:1)`;

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
    slackMemberId: report.devinEmail ? '' : AMDOCS_NWM_SLACK_MEMBER_ID,
    slackMemberIdFallback: AMDOCS_NWM_SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: `Amdocs NWM — Task Save & Complete (${platform === 'ios' ? 'iOS' : 'web'})`,
    customer: CUSTOMER,
    project: APP_PROJECT,
    release,
    title: `[Amdocs NWM] ${errorCode} Save & Complete failed for ${priority} task (${platform})`,
    sessionPlatform: AMDOCS_NWM_SESSION_PLATFORM || undefined,
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
    logger.error('Failed to create Devin session for Amdocs NWM failure report', {
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
  IOS_ERROR_PATH,
  APP_SCENARIO,
  APP_CULPRIT,
  ERROR_CODE,
  IOS_REPO,
  ANDROID_REPO,
  WEB_REPO,
  AMDOCS_NWM_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  platformOf,
  isAppReport,
  reportAppFailure,
};
