const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * LPL Financial ClientWorks (advisor web workstation, .NET / AngularJS) and its companion Account View
 * iOS app (SwiftUI), both in COG-GTM/lpl-clientworks-legacy.
 *
 * When the positions grid fails, either client posts one incident report to
 * POST /api/lpl/clientworks/error. This bridge raises the Slack alert and the Devin remediation session
 * against the legacy repository, always under the default (Devin GTM) customer config, created as the
 * reporting user resolved from `devinEmail`.
 */
const CUSTOMER = 'default';
const ERROR_PATH = '/api/lpl/clientworks/error';
const APP_REPO_NAME = 'COG-GTM/lpl-clientworks-legacy';
const APP_REPO = `github.com/${APP_REPO_NAME}`;
const SERVER_FILE = 'ClientWorks.Core/Positions/PositionGridService.cs';
const APP_CULPRIT = `${SERVER_FILE} — PositionGridService.ComputeDayChange`;
const APP_SCENARIO = 'positions-grid-day-change';
const GENERIC_CULPRIT = 'ClientWorks positions grid';
const GENERIC_SCENARIO = 'positions-grid-failure';
const KNOWN_ERROR_TYPE = 'System.DivideByZeroException';
const DAY_CHANGE_COLUMNS = ['dayChange', 'dayChangePct'];

// Fix sessions for Account View must drive the iOS Simulator, so they are placed on macOS; web
// sessions use the org default. Set either to '' for the org default or to another platform label.
const LPL_CLIENTWORKS_IOS_SESSION_PLATFORM = process.env.LPL_CLIENTWORKS_IOS_SESSION_PLATFORM === undefined
  ? 'macos'
  : process.env.LPL_CLIENTWORKS_IOS_SESSION_PLATFORM;
const LPL_CLIENTWORKS_WEB_SESSION_PLATFORM = process.env.LPL_CLIENTWORKS_WEB_SESSION_PLATFORM === undefined
  ? ''
  : process.env.LPL_CLIENTWORKS_WEB_SESSION_PLATFORM;

const CLIENTS = {
  web: {
    platform: 'web',
    source: 'clientworks/web',
    service: 'customer-lpl-clientworks-web',
    project: 'lpl-clientworks-web',
    appName: 'ClientWorks',
    release: 'clientworks@4.12.3',
    screen: 'account-positions',
    verticalLabel: 'LPL Financial — ClientWorks (web)',
  },
  ios: {
    platform: 'ios',
    source: 'clientworks/ios',
    service: 'customer-lpl-clientworks-ios',
    project: 'lpl-clientworks-ios',
    appName: 'Account View',
    release: 'account-view@4.12.3',
    screen: 'holdings',
    verticalLabel: 'LPL Financial — Account View (iOS)',
  },
};
const CLIENT_BY_SOURCE = Object.fromEntries(Object.values(CLIENTS).map((client) => [client.source, client]));

const REPORT_SAFETY = `Reproduction safety: every incident report from ClientWorks or Account View raises a real Slack alert and
Devin session. Keep failure reports off while reproducing — \`CW_DISABLE_INCIDENT_REPORTS=1\` (environment variable,
or the \`CW_DISABLE_INCIDENT_REPORTS\` appSetting in \`Web.config\`) for the web host, and the
\`-disableIncidentReports\` launch argument for Account View — unless the alert chain is being exercised on purpose.`;

const CLOSING_STEP = `Open a pull request against \`main\` of \`${APP_REPO_NAME}\`, request Devin Review, post findings back to
   the Slack thread, and stop for human approval before merging.`;

const SCOPE_NOTE = `Investigate and fix \`${APP_REPO_NAME}\` only — not this Node repository. Read the repo's \`README.md\` and
the local setup / runbook docs it links to first.`;

const MACOS_STEP = `This session is requested on macOS. Confirm with \`uname -s\` and \`xcodebuild -version\`: on macOS, do all
   the work here and do not create child sessions; only if this session is not on macOS (platform fallback),
   create one macOS child session for the Simulator work.`;

const KNOWN_WEB_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\` (.NET Framework 4.8 / ASP.NET Web API 2, AngularJS 1.x)

The ClientWorks positions grid fails to load for accounts holding a newly listed security. Advisors who open an
affected account's Positions screen get the grid's error state with a \`CW-…\` incident reference instead of their
positions; every other account loads normally. The failure follows the "Day Chg" / "Day Chg %" columns
(\`dayChange\`, \`dayChangePct\`), which are visible in the default layout for new users and can be added from the
column picker.

${SCOPE_NOTE}

Reported error:
- Type: \`${KNOWN_ERROR_TYPE}\` — "Attempted to divide by zero."
- Crash site: \`${APP_CULPRIT}\`
- Caller: the positions-grid Web API controller serving \`GET /api/accounts/{id}/positions-grid?columns=...\`
- Client: the AngularJS positions grid on the \`account-positions\` screen (actions \`positions_grid_load\` /
  \`positions_grid_save_layout\`)
- Client identity: \`${CLIENTS.web.service}\`, source \`${CLIENTS.web.source}\`, report endpoint \`POST ${ERROR_PATH}\`
- The failing account, its visible columns and the affected security are in this alert's tags (\`accountNumber\`,
  \`columns\`, \`securitySymbol\`).

Expected behavior: a position whose security has no prior close (missing or zero \`PrevClose\`) has no day change —
the API returns null for \`dayChange\` / \`dayChangePct\` and the grid renders "—" — and the rest of the grid loads.

Steps:
1. Bring up the local stack (SQL Server + web host) per the repo docs with incident reports disabled
   (\`CW_DISABLE_INCIDENT_REPORTS=1\`).
2. Reproduce: open the account from the \`accountNumber\` tag (or any account holding the \`securitySymbol\` tag's
   security) with "Day Chg %" visible and confirm the reported exception; confirm an account without that holding
   loads.
3. Find the root cause in \`PositionGridService.ComputeDayChange\` and how prior-close values reach it, and fix it so
   a missing or zero prior close never divides by zero. Do not catch and swallow the exception, hide or remove the
   Day Chg columns, or drop the affected positions.
4. Add a unit / characterization test for \`ComputeDayChange\` covering a null prior close, a zero prior close and a
   normal one, and run the test suite to green.
5. Keep incident reporting intact (client identity, report payload, and the grid's error state and incident
   reference for genuine failures). Record BEFORE/AFTER of the affected account's positions grid in the browser.
6. ${CLOSING_STEP}

${REPORT_SAFETY}`;

const KNOWN_IOS_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\` (.NET Framework 4.8 / ASP.NET Web API 2 server, SwiftUI iOS client under \`ios/\`)

Account View (iOS) fails to show holdings for accounts holding a newly listed security. Clients who open an affected
account's Holdings screen get the error state with a \`CW-…\` incident reference instead of their holdings; every
other account loads normally. The failure follows the day-change values (\`dayChange\`, \`dayChangePct\`) the
holdings view requests from the ClientWorks positions API — the same server path the ClientWorks web positions grid
uses.

${SCOPE_NOTE}

Reported error:
- Type: \`${KNOWN_ERROR_TYPE}\` — "Attempted to divide by zero."
- Crash site (server): \`${APP_CULPRIT}\`
- Caller: the positions-grid Web API endpoint (\`GET /api/accounts/{id}/positions-grid?columns=...\` and the
  client-facing equivalent Account View calls)
- Client: the SwiftUI holdings view under \`ios/\` (\`holdings\` screen, action \`positions_grid_load\`)
- Client identity: \`${CLIENTS.ios.service}\`, source \`${CLIENTS.ios.source}\`, report endpoint \`POST ${ERROR_PATH}\`
- The failing account, requested columns and the affected security are in this alert's tags (\`accountNumber\`,
  \`columns\`, \`securitySymbol\`).

Expected behavior: a position whose security has no prior close (missing or zero \`PrevClose\`) has no day change —
the API returns null for \`dayChange\` / \`dayChangePct\`, Account View renders "—" — and the rest of the holdings load.

Steps:
1. ${MACOS_STEP}
2. Bring up the local stack (SQL Server + web host) per the repo docs with incident reports disabled
   (\`CW_DISABLE_INCIDENT_REPORTS=1\`), and run Account View on the iOS Simulator against it with the
   \`-disableIncidentReports\` launch argument.
3. Reproduce: open the account from the \`accountNumber\` tag (or any account holding the \`securitySymbol\` tag's
   security) in Holdings and confirm the reported exception on the server; confirm an account without that holding
   loads.
4. Find the root cause in \`PositionGridService.ComputeDayChange\` and how prior-close values reach it, and fix it so
   a missing or zero prior close never divides by zero; make sure the holdings view renders a null day change as
   "—". Do not catch and swallow the exception, hide or remove the day-change values, or drop the affected
   positions.
5. Add a unit / characterization test for \`ComputeDayChange\` covering a null prior close, a zero prior close and a
   normal one, and run the test suites to green.
6. Keep incident reporting intact (client identity, report payload, and the error state and incident reference for
   genuine failures). Record BEFORE/AFTER of the affected account's holdings on the Simulator.
7. ${CLOSING_STEP}

${REPORT_SAFETY}`;

// Used when a report is not the known day-change failure: same repository, code path and process, without
// asserting a diagnosis the report does not carry.
const GENERIC_WEB_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\` (.NET Framework 4.8 / ASP.NET Web API 2, AngularJS 1.x)

A ClientWorks positions-grid request failed in production (load or layout save — see the \`action\` tag). The advisor
got the grid's error state with a \`CW-…\` incident reference. The error type and message are above; the account,
visible columns and security involved are in this alert's tags (\`accountNumber\`, \`columns\`, \`securitySymbol\`).

${SCOPE_NOTE}

Code path:
- Server: \`ClientWorks.Core/Positions/\` (\`PositionGridService\`), called from the positions-grid Web API controller
  serving \`GET /api/accounts/{id}/positions-grid?columns=...\`
- Client: the AngularJS positions grid on the \`account-positions\` screen
- Client identity: \`${CLIENTS.web.service}\`, source \`${CLIENTS.web.source}\`, report endpoint \`POST ${ERROR_PATH}\`

Steps:
1. Bring up the local stack (SQL Server + web host) per the repo docs with incident reports disabled
   (\`CW_DISABLE_INCIDENT_REPORTS=1\`).
2. Reproduce with this alert's \`accountNumber\`, \`columns\` and \`action\` tags and confirm the reported error.
3. Find the root cause and fix it. Do not catch and swallow the error, hide grid columns or drop positions.
4. Add a unit / characterization test that fails before and passes after the fix, and run the test suite to green.
5. Keep incident reporting intact (client identity, report payload, and the grid's error state and incident
   reference for genuine failures). Record BEFORE/AFTER of the reproduction in the browser.
6. ${CLOSING_STEP}

${REPORT_SAFETY}`;

const GENERIC_IOS_DIRECTIVE = `*Repository to investigate and fix:* \`${APP_REPO}\` (.NET Framework 4.8 / ASP.NET Web API 2 server, SwiftUI iOS client under \`ios/\`)

An Account View (iOS) holdings request failed in production (see the \`action\` tag). The client got the error state
with a \`CW-…\` incident reference. The error type and message are above; the account, requested columns and security
involved are in this alert's tags (\`accountNumber\`, \`columns\`, \`securitySymbol\`).

${SCOPE_NOTE}

Code path:
- Server: \`ClientWorks.Core/Positions/\` (\`PositionGridService\`), called from the positions-grid Web API endpoint
  (\`GET /api/accounts/{id}/positions-grid?columns=...\` and the client-facing equivalent Account View calls)
- Client: the SwiftUI holdings view under \`ios/\` (\`holdings\` screen)
- Client identity: \`${CLIENTS.ios.service}\`, source \`${CLIENTS.ios.source}\`, report endpoint \`POST ${ERROR_PATH}\`

Steps:
1. ${MACOS_STEP}
2. Bring up the local stack (SQL Server + web host) per the repo docs with incident reports disabled
   (\`CW_DISABLE_INCIDENT_REPORTS=1\`), and run Account View on the iOS Simulator against it with the
   \`-disableIncidentReports\` launch argument.
3. Reproduce with this alert's \`accountNumber\`, \`columns\` and \`action\` tags and confirm the reported error.
4. Find the root cause and fix it on the server and/or in the app. Do not catch and swallow the error, hide values or
   drop positions.
5. Add a unit / characterization test that fails before and passes after the fix, and run the test suites to green.
6. Keep incident reporting intact (client identity, report payload, and the error state and incident reference for
   genuine failures). Record BEFORE/AFTER of the reproduction on the Simulator.
7. ${CLOSING_STEP}

${REPORT_SAFETY}`;

function clip(value, max) {
  if (value === undefined || value === null) return '';
  return String(value).slice(0, max);
}

// .NET exception type as the server reports it, e.g. `System.DivideByZeroException`.
const ERROR_TYPE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}(\.[A-Za-z_][A-Za-z0-9_]{0,63}){0,7}$/;
const REFERENCE_PATTERN = /^CW-[0-9A-Fa-f]{8}$/;
const SCREEN_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const ACTION_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
const ACCOUNT_NUMBER_PATTERN = /^[0-9Xx*]{4}-[0-9Xx*]{4}$/;
const COLUMNS_PATTERN = /^[A-Za-z][A-Za-z0-9]{0,31}(,[A-Za-z][A-Za-z0-9]{0,31}){0,23}$/;
const SYMBOL_PATTERN = /^[A-Z0-9][A-Z0-9.]{0,11}$/;
const VERSION_PATTERN = /^[0-9]{1,4}(\.[0-9]{1,6}){0,3}$/;
const RELEASE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,40}@[0-9A-Za-z][0-9A-Za-z._+-]{0,30}$/;
const ENVIRONMENT_PATTERN = /^[a-z][a-z0-9-]{0,15}$/;
const EMAIL_PATTERN = /^[^\s@<>()[\]\\,;:"]{1,64}@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

function matching(value, pattern) {
  return typeof value === 'string' && pattern.test(value) ? value : '';
}

function sanitizeContext(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  return Object.fromEntries(Object.entries(value)
    .filter(([, entry]) => typeof entry === 'string' || (typeof entry === 'number' && Number.isFinite(entry)))
    .slice(0, 12)
    .map(([key, entry]) => [clip(key, 40), typeof entry === 'string' ? clip(entry, 256) : entry]));
}

function clientFor(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return Object.prototype.hasOwnProperty.call(CLIENT_BY_SOURCE, source) ? CLIENT_BY_SOURCE[source] : null;
}

/**
 * A report is accepted only when its source, service and platform agree on one client, its errorType is a
 * .NET type identity, and a client reference, if sent, has the `CW-<8 hex>` shape the apps generate.
 */
function isAppReport(body) {
  const client = clientFor(body);
  if (!client) return false;
  if (body.service !== client.service || body.platform !== client.platform) return false;
  if (typeof body.errorType !== 'string' || !ERROR_TYPE_PATTERN.test(body.errorType)) return false;
  if (body.reference !== undefined && body.reference !== null
    && !(typeof body.reference === 'string' && REFERENCE_PATTERN.test(body.reference))) return false;
  return true;
}

function columnList(report) {
  const columns = matching(report && report.columns, COLUMNS_PATTERN);
  return columns ? columns.split(',') : [];
}

// The known failure: decimal division by a missing/zero prior close while the grid computes day change.
function isKnownScenario(report) {
  if (!report || report.errorType !== KNOWN_ERROR_TYPE) return false;
  const action = matching(report.action, ACTION_PATTERN);
  if (!action.startsWith('positions_grid_')) return false;
  const stack = typeof report.stackTrace === 'string' ? report.stackTrace : '';
  return columnList(report).some((column) => DAY_CHANGE_COLUMNS.includes(column))
    || stack.includes('PositionGridService.ComputeDayChange');
}

function directiveFor(report) {
  const client = clientFor(report) || CLIENTS.web;
  if (isKnownScenario(report)) return client.platform === 'ios' ? KNOWN_IOS_DIRECTIVE : KNOWN_WEB_DIRECTIVE;
  return client.platform === 'ios' ? GENERIC_IOS_DIRECTIVE : GENERIC_WEB_DIRECTIVE;
}

function sessionPlatformFor(client) {
  const platform = client.platform === 'ios' ? LPL_CLIENTWORKS_IOS_SESSION_PLATFORM : LPL_CLIENTWORKS_WEB_SESSION_PLATFORM;
  return platform || undefined;
}

// Each client sends one report per incident with its own `reference`; a resend of the same reference for the
// same error (lost response, retry) within the window must not raise a second alert or session.
const RECENT_REPORT_TTL_MS = 10 * 60 * 1000;
const RECENT_REPORT_MAX = 200;
const recentReports = new Map();

function pruneRecentReports(now) {
  for (const [key, entry] of recentReports) {
    if (entry.expiresAt <= now) recentReports.delete(key);
  }
  while (recentReports.size > RECENT_REPORT_MAX) {
    recentReports.delete(recentReports.keys().next().value);
  }
}

function recentReportKey(report) {
  const reference = matching(report && report.reference, REFERENCE_PATTERN).toUpperCase();
  if (!reference) return '';
  return `${reference}|${clip(report.platform, 8)}|${clip(report.errorType, 128)}`;
}

function findRecentReport(report, now = Date.now()) {
  const key = recentReportKey(report);
  if (!key) return null;
  pruneRecentReports(now);
  const entry = recentReports.get(key);
  return entry && entry.delivered && entry.expiresAt > now ? entry : null;
}

// The same reference still being delivered; its `pending` promise resolves to whether delivery succeeded.
function findPendingReport(report, now = Date.now()) {
  const key = recentReportKey(report);
  if (!key) return null;
  pruneRecentReports(now);
  const entry = recentReports.get(key);
  return entry && !entry.delivered && entry.expiresAt > now ? entry : null;
}

// Remembered while dispatch is in flight and kept only once the alert/session was delivered, so a failed
// delivery leaves the reference free for the client to retry.
function rememberReport(report, reference, now = Date.now()) {
  const key = recentReportKey(report);
  if (!key) return () => {};
  pruneRecentReports(now);
  let settlePending;
  const pending = new Promise((resolve) => { settlePending = resolve; });
  recentReports.set(key, { reference, expiresAt: now + RECENT_REPORT_TTL_MS, delivered: false, pending });
  return (delivered) => {
    settlePending(Boolean(delivered));
    const entry = recentReports.get(key);
    if (!entry || entry.reference !== reference) return;
    if (delivered) entry.delivered = true;
    else recentReports.delete(key);
  };
}

function clearRecentReports() {
  recentReports.clear();
}

async function resolveUserIdByEmail(email, orgId) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !orgId) return '';
  try {
    const { apiKey } = getCustomerConfig(CUSTOMER);
    const auth = apiKey ? { apiKey } : {};
    const members = await listOrgUsers(orgId, auth);
    const member = members.find((user) => (user.email || '').toLowerCase() === normalized);
    if (member) return member.user_id;
    const admins = await listEnterpriseAdmins(auth);
    const admin = admins.find((user) => (user.email || '').toLowerCase() === normalized);
    if (admin) return admin.user_id;
    logger.warn('ClientWorks reporter email not found in org', { orgId });
  } catch (error) {
    logger.warn('ClientWorks reporter lookup failed', { error: error.message, orgId });
  }
  return '';
}

function reportAppFailure(report) {
  const client = clientFor(report);
  const reference = uuidv4();
  const clientReference = matching(report.reference, REFERENCE_PATTERN);
  const { platform } = client;
  const screen = matching(report.screen, SCREEN_PATTERN) || client.screen;
  const action = matching(report.action, ACTION_PATTERN) || 'positions_grid_load';
  const accountNumber = matching(report.accountNumber, ACCOUNT_NUMBER_PATTERN);
  const columns = columnList(report).join(',');
  const appVersion = matching(report.appVersion, VERSION_PATTERN);
  const appName = clip(report.appName || client.appName, 64);
  const errorType = clip(report.errorType, 128);
  // Single line only: the message reaches the alert title and prompt, so it cannot carry its own sections.
  const errorMessage = clip(
    // eslint-disable-next-line no-control-regex
    String(report.errorMessage || '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim()
      || 'Positions grid request failed',
    512,
  );
  const stackTrace = clip(report.stackTrace, 4000);
  const release = matching(report.release, RELEASE_PATTERN) || client.release;
  const environment = matching(report.environment, ENVIRONMENT_PATTERN) || process.env.DD_ENV || 'prod';
  const devinEmail = matching(typeof report.devinEmail === 'string' ? report.devinEmail.trim() : '', EMAIL_PATTERN);
  const context = sanitizeContext(report.context);
  const knownScenario = isKnownScenario(report);
  const securitySymbol = matching(context && context.securitySymbol, SYMBOL_PATTERN);

  // Only pattern-checked identifiers become tags (and so reach the prompt); everything else stays in `extra`.
  const tags = {
    route: ERROR_PATH,
    service: client.service,
    customer: client.service,
    platform,
    screen,
    action,
    ...(accountNumber ? { accountNumber } : {}),
    ...(columns ? { columns } : {}),
    ...(securitySymbol ? { securitySymbol } : {}),
    ...(clientReference ? { clientReference } : {}),
    scenario: knownScenario ? APP_SCENARIO : GENERIC_SCENARIO,
    alert_path: 'instant',
  };

  incrementMetric('clientworks.positions_grid.failure', {
    route: ERROR_PATH,
    errorClass: errorType,
    platform,
    screen,
    action,
  });

  logger.error('ClientWorks positions grid failure reported', {
    reference,
    clientReference,
    service: client.service,
    platform,
    screen,
    action,
    accountNumber,
    securitySymbol,
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
    accountNumber,
    columns,
    appVersion,
    appName,
  };
  if (context !== undefined) extra.context = context;

  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST ${ERROR_PATH}`);
    Sentry.captureException(error, { tags, extra });
  });

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${client.project}&query=${encodeURIComponent(`is:unresolved service:${client.service}`)}`,
    culprit: knownScenario ? APP_CULPRIT : `${GENERIC_CULPRIT} — ${action}`,
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail: devinEmail || undefined,
    service: client.service,
    verticalLabel: client.verticalLabel,
    customer: CUSTOMER,
    project: client.project,
    release,
    sessionPlatform: sessionPlatformFor(client),
    promptAppendix: directiveFor(report),
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      ...extra,
      stackTrace,
      reporterEmail: devinEmail,
    },
    level: 'error',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    environment,
    triggeredRule: '',
  });

  const settleRecentReport = rememberReport(report, reference);
  // Always the Devin GTM org of the default config; client-sent org/user ids are not part of the contract.
  const lookupOrgId = getCustomerConfig(CUSTOMER).devinOrgId || process.env.DEVIN_ORG_ID || '';
  const sessionPromise = (devinEmail && lookupOrgId
    ? resolveUserIdByEmail(devinEmail, lookupOrgId).then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(undefined)
  ).then((result) => {
    settleRecentReport(Boolean(result));
    return Boolean(result);
  }).catch((alertError) => {
    settleRecentReport(false);
    logger.error('Failed to create Devin session for ClientWorks positions grid failure', {
      error: alertError.message,
      reference,
    });
    return false;
  });

  return { reference, sessionPromise };
}

module.exports = {
  CUSTOMER,
  CLIENTS,
  ERROR_PATH,
  APP_REPO,
  APP_REPO_NAME,
  APP_CULPRIT,
  APP_SCENARIO,
  GENERIC_CULPRIT,
  GENERIC_SCENARIO,
  KNOWN_ERROR_TYPE,
  LPL_CLIENTWORKS_IOS_SESSION_PLATFORM,
  LPL_CLIENTWORKS_WEB_SESSION_PLATFORM,
  KNOWN_WEB_DIRECTIVE,
  KNOWN_IOS_DIRECTIVE,
  GENERIC_WEB_DIRECTIVE,
  GENERIC_IOS_DIRECTIVE,
  ERROR_TYPE_PATTERN,
  REFERENCE_PATTERN,
  clientFor,
  isAppReport,
  isKnownScenario,
  directiveFor,
  sessionPlatformFor,
  findRecentReport,
  findPendingReport,
  clearRecentReports,
  reportAppFailure,
  resolveUserIdByEmail,
};
