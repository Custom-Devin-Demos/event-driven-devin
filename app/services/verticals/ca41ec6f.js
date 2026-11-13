const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { createSessionAndAlert } = require('../devin-session');

// Proactive latency demo: an (imagined, never rendered) Datadog APM monitor on a Doctolib-look
// patient search warns before the availability endpoint reaches its gateway timeout. Nothing is
// sent to Datadog; the only visible signal is the Slack alert card, which links back to the page. The fix lands on the `doctolib` branch of
// the three joao-cognition demo repos, following the skill kept in the backend repo.
const CUSTOMER = 'ca41ec6f';
const APP_SERVICE = 'doctolib-search-api';
const MONITOR_PATH = '/api/ca41ec6f/monitor/alert';
// The Doctolib iOS app (joao-cognition/demo_ios, branch doctolib) times its availability calls and
// reports here when p95 crosses the warn threshold; this is the demo's primary entry point.
const IOS_LATENCY_PATH = '/api/doctolib/ios/latency';
const SOURCE_PREFIX = 'doctolib/';
const PLATFORM_LABELS = { web: 'web', ios: 'iOS', android: 'Android' };
const MONITOR_NAME = '[Warn] doctolib-search-api p95 latency — GET /api/doctolib/practitioners/:id/availability';
const ROUTE = 'GET /api/doctolib/practitioners/:id/availability';
const SLOW_QUERY = 'appointments.next_availability';
const WARN_THRESHOLD_MS = 800;
const GATEWAY_TIMEOUT_MS = 3000;
const BRANCH = 'doctolib';
const BACKEND_REPO = 'joao-cognition/demo_webapp';
const ANDROID_REPO = 'joao-cognition/demo_android';
const IOS_REPO = 'joao-cognition/demo_ios';
const REPOS = [BACKEND_REPO, ANDROID_REPO, IOS_REPO];
const SKILL_NAME = 'doctolib-latency-incident-fix';
const SKILL_PATH = '.agents/skills/cross-platform-incident-fix/SKILL.md';
const SESSION_PLATFORM = process.env.DOCTOLIB_SEARCH_SESSION_PLATFORM === undefined
  ? 'linux'
  : process.env.DOCTOLIB_SEARCH_SESSION_PLATFORM;
const SLACK_MEMBER_ID = process.env.DOCTOLIB_SEARCH_SLACK_MEMBER_ID || '';

const REMEDIATION_DIRECTIVE = `*Repositories (branch \`${BRANCH}\` in all three):* \`github.com/${BACKEND_REPO}\` (Node backend + Doctolib web, React/Next.js), \`github.com/${ANDROID_REPO}\` (Kotlin / Jetpack Compose, \`DoctolibApp/\`) and \`github.com/${IOS_REPO}\` (Swift / SwiftUI, \`DoctolibApp/\`)

This is a synthetic Doctolib demonstration, not Doctolib code or patient data. The alert is a simulated Datadog APM monitor:
nothing was posted to Datadog. It is WARNING, not failing: p95 latency of \`${ROUTE}\` is above ${WARN_THRESHOLD_MS} ms and
closing in on the ${GATEWAY_TIMEOUT_MS} ms gateway timeout. Patients searching "Dermatologue · Paris" wait for the
"prochaine disponibilité" on every result card. Fix it before it becomes a timeout.

You are the LEAD Devin. Run the skill *${SKILL_NAME}* end to end (if it is not loaded, follow \`${SKILL_PATH}\` in
\`${BACKEND_REPO}\` on the \`${BRANCH}\` branch, Doctolib scenario); it overrides this session's playbook. Clone every repository at the \`${BRANCH}\` branch and open every PR against
\`${BRANCH}\`. Read \`AGENTS.md\`, \`docs/SHARED-BACKEND-DEMO.md\` and \`docs/QA-HANDOFF.md\` in the backend repo first. Do not clone,
change or open PRs in \`COG-GTM/event-driven-devin\` or \`COG-GTM/doctolib-grand-public\`, even though this hosted page lives there.
1. ROOT CAUSE IN THE BACKEND (isolated run, DOCTOLIB_ENABLE_INCIDENTS=0): reproduce with \`npm run bench\`, read
   \`GET /api/doctolib/metrics\` (slow-query log), run \`npm run explain\` on the slowest statement, count the SQL statements and
   HTTP calls one search page costs, capture \`npm run parity:contract\`.
2. SHORT RCA to the user (3 sentences + BEFORE/AFTER diagram). Constraints: keep \`${ROUTE}\` working for older app versions;
   additive, online-safe schema changes only; never serve stale or cached availability (a booked slot shown as free is a double
   booking); do not raise the gateway timeout or the monitor threshold. Open the backend PR yourself.
3. THREE child Devin sessions IN PARALLEL, one per client, all pinned to the backend fix SHA:
   - a *macOS* child for \`${IOS_REPO}\` (\`DoctolibApp/\`): \`swift test --package-path DoctolibApp/DoctolibKit\`, Xcode + iPhone simulator,
     DOCTOLIB_API_BASE_URL=http://127.0.0.1:3001.
   - a *Linux* child for \`${ANDROID_REPO}\` (\`DoctolibApp/\`): \`./gradlew testDebugUnitTest assembleDebug -PdoctolibApiBaseUrl=http://10.0.2.2:3001\`, emulator.
   - a *Linux* child for \`${BACKEND_REPO}\` (\`web/\` only): \`npm run build:web\`, \`npm run qa:web\`.
   Each child adopts the new availability contract, keeps booking and the SLOT_TAKEN conflict path, adds tests, records BASE then FIX
   on its real browser / emulator / simulator (API calls per search page, time to all slots visible) and returns parity rows P1-P5.
4. PARITY + BEFORE/AFTER (p50/p95, SQL statements and HTTP calls per page, EXPLAIN plan) posted on every PR, then the HTML fix
   report (\`npm run fix-report\`). Devin Review on each PR; the owning session fixes findings. Then request human review and stop.
Never merge, deploy, fire incidents or post to Slack/Teams. This hosted page keeps the planted behaviour so the demo can be re-run;
open it with \`?reports=off\` for any QA.`;

function clip(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

function toInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const rounded = Math.round(n);
  return rounded >= min && rounded <= max ? rounded : null;
}

// The page sends the monitor window it observed; only numbers are accepted, the directive and
// repositories above are fixed server-side.
function platformOf(report) {
  if (report.source === undefined) return 'web';
  if (typeof report.source !== 'string' || !report.source.startsWith(SOURCE_PREFIX)) return '';
  const platform = report.source.slice(SOURCE_PREFIX.length);
  return Object.hasOwn(PLATFORM_LABELS, platform) ? platform : '';
}

function parseMonitorAlert(body) {
  const report = body && typeof body === 'object' ? body : {};
  if (report.service !== APP_SERVICE) return null;
  const platform = platformOf(report);
  if (!platform) return null;
  const p95Ms = toInt(report.p95Ms, WARN_THRESHOLD_MS, 60000);
  const p50Ms = toInt(report.p50Ms, 0, 60000);
  const samples = toInt(report.samples, 1, 100000);
  const callsPerPage = toInt(report.callsPerPage, 1, 1000);
  const queryP95Ms = toInt(report.queryP95Ms, 0, 60000);
  if (p95Ms === null || samples === null) return null;
  const allSlotsMs = toInt(report.allSlotsMs, 0, 600000);
  return {
    platform,
    appVersion: clip(report.appVersion, 32),
    device: clip(report.device, 64),
    osVersion: clip(report.osVersion, 64),
    allSlotsMs: allSlotsMs === null ? undefined : allSlotsMs,
    p95Ms,
    p50Ms: p50Ms === null ? undefined : p50Ms,
    samples,
    callsPerPage: callsPerPage === null ? 21 : callsPerPage,
    queryP95Ms: queryP95Ms === null ? undefined : queryP95Ms,
    rowsScanned: toInt(report.rowsScanned, 0, 100000000) || 602611,
    devinUserId: clip(report.devinUserId, 128) || undefined,
    devinOrgId: clip(report.devinOrgId, 128) || undefined,
    devinEmail: clip(report.devinEmail, 128),
  };
}

function monitorUrl() {
  const base = (process.env.PUBLIC_BASE_URL || 'https://devindemos.com').replace(/\/$/, '');
  return `${base}/doctolib-search`;
}

function raiseLatencyWarning(alert) {
  const reference = uuidv4();
  const platform = alert.platform || 'web';
  const reporter = `the Doctolib ${PLATFORM_LABELS[platform]} app${alert.appVersion ? ` ${alert.appVersion}` : ''}${alert.device ? ` on ${alert.device}` : ''}`;
  const issueTitle = `[Warn] ${APP_SERVICE}: p95 ${alert.p95Ms} ms on ${ROUTE} (warn ${WARN_THRESHOLD_MS} ms, gateway timeout ${GATEWAY_TIMEOUT_MS} ms)`;
  const tags = {
    service: APP_SERVICE,
    env: 'prod',
    route: ROUTE,
    monitor_type: 'apm.latency.p95',
    query: SLOW_QUERY,
    branch: BRANCH,
    platform,
    alert_path: 'instant',
  };
  const extra = {
    reference,
    reportedBy: reporter,
    platform,
    appVersion: alert.appVersion || undefined,
    device: alert.device || undefined,
    osVersion: alert.osVersion || undefined,
    timeToAllSlotsMs: alert.allSlotsMs,
    monitor: MONITOR_NAME,
    p95Ms: alert.p95Ms,
    p50Ms: alert.p50Ms,
    samples: alert.samples,
    thresholdMs: WARN_THRESHOLD_MS,
    timeoutMs: GATEWAY_TIMEOUT_MS,
    httpCallsPerSearchPage: alert.callsPerPage,
    slowestQuery: SLOW_QUERY,
    slowestQueryP95Ms: alert.queryP95Ms,
    rowsScanned: alert.rowsScanned,
    simulated: 'imagined Datadog APM monitor; nothing posted to Datadog and no monitor UI',
  };

  incrementMetric('doctolib_search.latency_warning', { route: ROUTE, p95Ms: alert.p95Ms });
  logger.warn('Doctolib search latency monitor warning', extra);

  const sessionPromise = Promise.resolve(createSessionAndAlert({
    issueTitle,
    issueUrl: monitorUrl(),
    datadogUrl: monitorUrl(),
    culprit: `backend/practitioners.js — nextAvailability (${SLOW_QUERY}, Seq Scan on appointments)`,
    errorType: 'APM latency monitor (warn)',
    errorValue: `Reported by ${reporter}: p95 ${alert.p95Ms} ms over the last ${alert.samples} requests; ${alert.callsPerPage} HTTP calls per search page; `
      + `slowest query ${SLOW_QUERY}${alert.queryP95Ms ? ` p95 ${alert.queryP95Ms} ms` : ''} (Seq Scan, ${alert.rowsScanned} rows)`,
    devinUserId: alert.devinUserId,
    devinEmail: alert.devinEmail,
    devinOrgId: alert.devinOrgId,
    slackMemberId: alert.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    service: APP_SERVICE,
    verticalLabel: 'Doctolib — patient search latency (proactive)',
    customer: CUSTOMER,
    project: 'doctolib-patient-search',
    release: 'doctolib-search-api@26.11.0',
    title: `[Doctolib] p95 ${alert.p95Ms} ms on patient search availability — warn before timeout`,
    sessionPlatform: SESSION_PLATFORM || undefined,
    repos: REPOS,
    promptAppendix: REMEDIATION_DIRECTIVE,
    skipVulnerablePr: true,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra,
    level: 'warning',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: String(alert.samples),
    shortId: '',
    environment: 'prod',
    triggeredRule: MONITOR_NAME,
  })).catch((error) => {
    logger.error('Failed to create Devin session for Doctolib latency warning', { error: error.message, reference });
  });

  return { reference, sessionPromise };
}

module.exports = {
  CUSTOMER,
  APP_SERVICE,
  MONITOR_PATH,
  IOS_LATENCY_PATH,
  SOURCE_PREFIX,
  MONITOR_NAME,
  ROUTE,
  WARN_THRESHOLD_MS,
  GATEWAY_TIMEOUT_MS,
  BRANCH,
  REPOS,
  SKILL_NAME,
  SKILL_PATH,
  REMEDIATION_DIRECTIVE,
  parseMonitorAlert,
  raiseLatencyWarning,
};
