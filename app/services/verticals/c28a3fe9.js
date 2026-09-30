const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * S&P Capital IQ Pro Market Monitor (github.com/rdf004/s-and-p-event-driven-demo).
 *
 * The customer surface is a Vite/React SPA served here as a static build at
 * /c28a3fe9/app. When a Global Indices row fails to load its index detail the
 * client POSTs the failure to /api/c28a3fe9/error so the Slack alert + Devin
 * session are raised under the app identity without a Sentry webhook
 * round-trip.
 */
const CUSTOMER = 'c28a3fe9';
const APP_SERVICE = `customer-${CUSTOMER}-web`;
const APP_PROJECT = 'capital-iq-market-monitor';
const APP_RELEASE = 'capital-iq-demo@0.1.0';
const APP_SOURCE_PREFIX = 'capital-iq/';
const APP_REPO = 'github.com/rdf004/s-and-p-event-driven-demo';
const APP_WEB_PATH = '/c28a3fe9/app';
const SCENARIO = 'global-indices-detail';

/** Roshan Fernando owns this demo: the Slack card and the Devin session are his. */
const OWNER = {
  slackMemberId: 'U09SE7WP21F',
  email: 'roshan.fernando@cognition.ai',
};

/**
 * Scenario directive appended to the Devin investigation prompt. The alert
 * pipeline passes only a prompt to the Devin API, so the repository to
 * remediate and the surfaces to verify have to be named explicitly here.
 */
const APP_REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${APP_REPO}\``,
  '',
  'This error was raised by the S&P Capital IQ Pro Market Monitor: a Vite + React 19 +',
  'TypeScript dashboard running entirely on mocked market data. Read `README.md` in that',
  'repo first.',
  '',
  'The failing code path is the index detail load in the Global Indices widget:',
  '- Entry: `onSelectIndex` in `src/App.tsx` (row click in `src/components/GlobalIndices.tsx`)',
  '- Detail builder: `buildIndexDetail` in `src/services/indexService.ts`',
  '- Data behind it: `INDICES` in `src/data/indices.ts` and `LISTINGS` in `src/data/listings.ts`',
  '',
  `The alert came from the hosted build at \`https://devindemos.com${APP_WEB_PATH}\` (served from`,
  `\`app/public/verticals/${CUSTOMER}-app/\` in \`COG-GTM/event-driven-devin\`).`,
  '',
  'Steps:',
  '1. Reproduce first: `npm install && npm run dev`, click the index named in the alert in the',
  '   Global Indices widget and confirm the "Unable to load index details" toast. Check which',
  '   other rows fail the same way before changing anything.',
  '2. Fix the mismatch, not just the crash site: make the listing data agree with the tickers',
  '   the widget requests, and make `buildIndexDetail` fail with an explicit, typed error for a',
  '   ticker it cannot resolve instead of dereferencing undefined.',
  '3. Add the prevention control: a check that every ticker in `INDICES` resolves to a',
  '   listing. `npm run typecheck`, `npm run lint` and `npm run build` must pass.',
  `   Do not change the incident reporting identity in \`src/services/incident.ts\` (\`${APP_SERVICE}\`).`,
  '4. Re-run the reproduction on the fix commit and confirm every Americas, Europe and Asia',
  '   index loads and switches the price chart.',
  '5. Open a pull request against `main` and STOP for human approval.',
  `6. After approval, refresh the hosted build: \`npx vite build --base=${APP_WEB_PATH}/\` on the`,
  `   fix commit, copy \`dist/\` (without source maps) into \`app/public/verticals/${CUSTOMER}-app/\``,
  `   in \`COG-GTM/event-driven-devin\`, and open a PR there so \`${APP_WEB_PATH}\` picks up the fix.`,
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

/** True when a request body carries the Market Monitor app identity. */
function isAppReport(body) {
  const source = body && typeof body.source === 'string' ? body.source : '';
  return source.startsWith(APP_SOURCE_PREFIX) && body.service === APP_SERVICE;
}

/**
 * Resolve the reporting user from an email when the client could not supply a
 * user id. Returns '' when nobody matches so the session falls back to the
 * customer config.
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
    logger.warn('Capital IQ reporter email not found in org', { orgId });
  } catch (err) {
    logger.warn('Capital IQ reporter lookup failed', { error: err.message, orgId });
  }
  return '';
}

/**
 * Bridge a failure reported by the Market Monitor client into the Slack alert
 * + Devin session flow under the app identity. The client has already rendered
 * its error toast; this is telemetry only.
 */
function reportAppFailure(report) {
  const reference = uuidv4();
  const platform = clip(report.platform || 'web', 32);
  const widget = clip(report.widget || 'global-indices', 64);
  const action = clip(report.action || 'load_index_detail', 64);
  const ticker = clip(report.ticker || 'unknown', 32);
  const region = clip(report.region || 'unknown', 32);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Index detail failed to load', 512);
  const stackTrace = clip(report.stackTrace, 4000);
  const release = clip(report.release || APP_RELEASE, 64);
  const environment = clip(report.environment || process.env.DD_ENV || 'prod', 32);
  const context = sanitizeReport(report.report);
  const devinEmail = clip(report.devinEmail || OWNER.email, 128);
  const devinOrgId = clip(
    report.devinOrgId || getCustomerConfig(CUSTOMER).devinOrgId || process.env.DEVIN_ORG_ID || '',
    128,
  );

  const tags = {
    route: `/api/${CUSTOMER}/error`,
    service: APP_SERVICE,
    customer: APP_SERVICE,
    platform,
    widget,
    action,
    ticker,
    region,
    scenario: SCENARIO,
  };

  incrementMetric('global_indices.detail_failure', {
    route: `/api/${CUSTOMER}/error`,
    errorClass: errorType,
    region,
  });

  logger.error('Capital IQ Market Monitor reported a failure', {
    reference,
    service: APP_SERVICE,
    widget,
    action,
    ticker,
    region,
    errorClass: errorType,
    error: errorMessage,
  });

  const error = new Error(errorMessage);
  error.name = errorType;
  if (stackTrace) error.stack = `${errorType}: ${errorMessage}\n${stackTrace}`;

  // Browser frames carry no Node module path, so Sentry derives the issue
  // culprit from the transaction; naming it after the route keeps the slug in
  // `issue.culprit` for tagless issue webhooks (isInstantPathEvent).
  Sentry.withScope((scope) => {
    scope.setTransactionName(`POST /api/${CUSTOMER}/error`);
    Sentry.captureException(error, {
      tags: { ...tags, alert_path: 'instant' },
      extra: { reference, release, environment, report: context },
    });
  });

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=is%3Aunresolved`,
    culprit: `${CUSTOMER}/src/services/indexService.ts \u2014 buildIndexDetail`,
    errorType,
    errorValue: errorMessage,
    devinUserId,
    devinEmail,
    devinOrgId: devinOrgId || undefined,
    slackMemberId: OWNER.slackMemberId,
    slackMemberIdFallback: OWNER.slackMemberId,
    service: APP_SERVICE,
    verticalLabel: 'S&P Capital IQ Pro',
    promptAppendix: APP_REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: {
      reference,
      stackTrace,
      report: context,
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

  const needsLookup = !report.devinUserId && devinEmail && devinOrgId;
  const sessionPromise = (needsLookup
    ? resolveUserIdByEmail(devinEmail, devinOrgId)
      .then((userId) => raiseAlert(userId || undefined))
    : raiseAlert(report.devinUserId || undefined)
  ).catch((err) => {
    logger.error('Failed to create Devin session for Capital IQ failure report', {
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
  reportAppFailure,
};
