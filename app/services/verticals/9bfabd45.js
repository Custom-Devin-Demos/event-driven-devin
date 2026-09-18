const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * BNY NEXEN custody platform (github.com/COG-GTM/bny).
 *
 * The customer surface is a Vite/React SPA served here as a static build at
 * /9bfabd45/app; the Spring Boot API in the same repo is not deployed. The
 * client aggregates the collateral book in the browser and POSTs failures to
 * /api/9bfabd45/error so the Slack alert + Devin session are raised under the
 * app identity without a Sentry webhook round-trip.
 */
const CUSTOMER = '9bfabd45';
const APP_SERVICE = `customer-${CUSTOMER}-web`;
const APP_PROJECT = 'nexen-custody';
const APP_RELEASE = 'nexen-custody@1.0.0';
const APP_SOURCE_PREFIX = 'nexen-custody/';
const APP_REPO = 'github.com/COG-GTM/bny';
const APP_WEB_PATH = '/9bfabd45/app';
const SCENARIO = 'collateral-overview-aggregate';

/** Hannah Huh owns this demo: the Slack card and the Devin session are hers. */
const OWNER = {
  slackMemberId: 'U0B2YAUPSHL',
  email: 'hannah.huh@cognition.ai',
};

/**
 * Scenario directive appended to the Devin investigation prompt. The alert
 * pipeline passes only a prompt to the Devin API, so the repository to
 * remediate and the surfaces to verify have to be named explicitly here.
 */
const APP_REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${APP_REPO}\``,
  '',
  'This error was raised by NEXEN, the BNY custody platform: a Vite + React 19 + TypeScript',
  'frontend (`frontend/`) over a Spring Boot 3 / Java 21 API (`backend/`) that mirrors the same',
  'domain model. Read `README.md` in that repo first.',
  '',
  'The failing code path is the Collateral Overview dashboard, the landing screen:',
  '- Client list: `frontend/src/api/fixtures.ts` (`clients`) and its Java mirror',
  '  `backend/src/main/resources/data.sql` (`client`, `legal_entity`, `collateral_allocation`)',
  '- Collateral aggregates: `collateralByClient` in `frontend/src/api/fixtures.ts`',
  '- Crash site: `summariseCollateral` in `frontend/src/domain/collateral.ts`',
  '- Entry: `frontend/src/pages/DashboardsPage.tsx` (Client selector on Collateral Overview),',
  '  served by `getCollateralOverview` in `frontend/src/api/mockClient.ts`',
  '- Backend counterpart: `ClientService#collateralOverview`',
  '',
  `The alert came from the hosted build at \`https://devindemos.com${APP_WEB_PATH}\` (served from`,
  `\`app/public/verticals/${CUSTOMER}-app/\` in \`COG-GTM/event-driven-devin\`), running the frontend's`,
  'mock client — no backend is deployed.',
  '',
  'Steps:',
  '1. Reproduce first: `cd frontend && npm install && npm run dev`, open Collateral Overview and',
  '   select MERIDIAN CAPITAL PARTNERS in the Client selector — the dashboard fails to load.',
  '   Note the test suites are GREEN on the broken baseline: nothing asserts that every client in',
  '   `clients` has a collateral aggregate behind it.',
  '2. Fix the data, not just the crash site: give the onboarded client its collateral aggregate and',
  '   legal-entity rows in both mirrors (`frontend/src/api/fixtures.ts` and',
  '   `backend/src/main/resources/data.sql`), and make `summariseCollateral` reject an unknown',
  '   client explicitly (typed error surfaced to the UI) instead of dereferencing undefined.',
  '3. Add the prevention control: a frontend test asserting every entry in `clients` has a',
  '   `collateralByClient` aggregate, a backend test for the same invariant over the seeded',
  '   clients, and coverage for the unknown-client path.',
  '   `npx tsc -b`, `npx oxlint`, `npm run build` and `./gradlew test` must pass.',
  `   Do not change the incident reporting identity in \`frontend/src/lib/incident.ts\` (\`${APP_SERVICE}\`).`,
  '4. Re-run the reproduction on the fix commit and confirm every client in the selector renders',
  '   KPIs, the legal-entity table and both allocation donuts.',
  '5. Open a pull request against `main`, request Devin Review, and STOP for human approval.',
  `6. After approval, refresh the hosted build: \`npm run build\` with base \`${APP_WEB_PATH}/\` on the`,
  `   fix commit, copy \`frontend/dist/\` into \`app/public/verticals/${CUSTOMER}-app/\` in`,
  `   \`COG-GTM/event-driven-devin\`, and open a PR there so \`${APP_WEB_PATH}\` picks up the fix.`,
].join('\n');

function clip(value, max) {
  const text = value == null ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

const MAX_REPORT_ENTRIES = 24;

/** Keep only flat scalar report metadata so Sentry/Slack payloads stay bounded. */
function sanitizeReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return {};
  const out = {};
  for (const [key, value] of Object.entries(report)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[clip(key, 64)] = typeof value === 'string' ? clip(value, 256) : value;
    }
    if (Object.keys(out).length >= MAX_REPORT_ENTRIES) break;
  }
  return out;
}

/** True when a request body comes from the NEXEN client. */
function isAppSource(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return source.startsWith(APP_SOURCE_PREFIX);
}

/** True when a request body carries the NEXEN app identity. */
function isAppReport(body) {
  return isAppSource(body) && body.service === APP_SERVICE;
}

/**
 * Resolve the reporting user from the email the client supplied, when it could
 * not supply a user id itself. Returns '' when nobody matches so the caller
 * falls back to the customer config. The lookup authenticates with this
 * customer's service key.
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
    logger.warn('NEXEN reporter email not found in org', { orgId });
  } catch (err) {
    logger.warn('NEXEN reporter lookup failed', { error: err.message, orgId });
  }
  return '';
}

/**
 * Bridge a failure reported by the NEXEN client into the Slack alert + Devin
 * session flow under the app identity. The client has already rendered its
 * error state; this is telemetry only.
 */
function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'web', 32);
  const screen = clip(report.screen || 'collateral_overview', 64);
  const action = clip(report.action || 'load_collateral_overview', 64);
  const accountNumber = clip(report.accountNumber || 'unknown', 64);
  const clientName = clip(report.clientName || 'unknown', 128);
  const market = clip(report.market || 'unknown', 8);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Collateral overview failed to load', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const custodyReport = sanitizeReport(report.report);
  const devinEmail = clip(report.devinEmail || OWNER.email, 128);

  const tags = {
    route: '/api/9bfabd45/error',
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    screen,
    action,
    account_number: accountNumber,
    client_name: clientName,
    market,
    scenario: SCENARIO,
  };

  incrementMetric('collateral_overview.failure', {
    route: '/api/9bfabd45/error',
    errorClass: errorType,
    platform,
    market,
  });

  logger.error('NEXEN reported a failure', {
    reference,
    service: APP_SERVICE,
    platform,
    screen,
    action,
    accountNumber,
    clientName,
    market,
    errorClass: errorType,
    error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  // The browser frames carry no Node module path, so Sentry derives the issue
  // culprit from the transaction; naming it after the route keeps the customer
  // slug in `issue.culprit` for tagless issue webhooks (isInstantPathEvent in
  // app/routes/sentry-webhook.js).
  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST /api/${CUSTOMER}/error`);
    Sentry.captureException(error, {
      tags: { ...tags, alert_path: 'instant' },
      extra: { reference, release, environment, report: custodyReport },
    });
  });

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=is%3Aunresolved`,
    culprit: `${CUSTOMER}/frontend/src/domain/collateral.ts \u2014 summariseCollateral`,
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail,
    devinOrgId: report.devinOrgId,
    slackMemberId: OWNER.slackMemberId,
    slackMemberIdFallback: OWNER.slackMemberId,
    service: APP_SERVICE,
    verticalLabel: 'BNY NEXEN',
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference,
      stackTrace,
      report: custodyReport,
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

  const needsLookup = !report.devinUserId && devinEmail && report.devinOrgId;
  const sessionPromise = (needsLookup
    ? resolveUserIdByEmail(devinEmail, report.devinOrgId)
      .then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(report.devinUserId)
  ).catch((err) => {
    logger.error('Failed to create Devin session for NEXEN failure report', {
      error: err.message,
      reference,
    });
  });

  return { reference, sessionPromise };
}

module.exports = {
  APP_SERVICE,
  APP_PROJECT,
  APP_RELEASE,
  APP_SOURCE_PREFIX,
  APP_REPO,
  APP_WEB_PATH,
  APP_REMEDIATION_DIRECTIVE,
  OWNER,
  SCENARIO,
  isAppReport,
  isAppSource,
  reportAppFailure,
};
