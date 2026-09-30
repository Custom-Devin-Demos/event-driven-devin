const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../devin-api');
const { getCustomerConfig } = require('../../../config/customers');
const { INDICES, LISTINGS } = require('./c28a3fe9-listings');

/**
 * S&P Capital IQ Pro Market Monitor. The Vite/React build of
 * github.com/rdf004/s-and-p-event-driven-demo is served at /c28a3fe9/app and
 * loads each Global Indices row's detail from POST /api/c28a3fe9/index-detail.
 */
const CUSTOMER = 'c28a3fe9';
const ROUTE = `/api/${CUSTOMER}/index-detail`;
const SERVICE = `customer-${CUSTOMER}-web`;
const APP_WEB_PATH = `/${CUSTOMER}/app`;
const SCENARIO = 'global-indices-detail';

/** Demo owner: on-call and session owner when the hub has no signed-in user. */
const OWNER = {
  slackMemberId: 'U09SE7WP21F',
  email: 'roshan.fernando@cognition.ai',
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the S&P Capital IQ Pro Market Monitor index detail load:',
  `- Service: \`app/services/verticals/${CUSTOMER}.js\` (\`buildIndexDetail\`)`,
  `- Reference data: \`app/services/verticals/${CUSTOMER}-listings.js\` (\`INDICES\`, \`LISTINGS\`)`,
  `- Route: \`app/routes/verticals/${CUSTOMER}.js\``,
  `- Page: the prebuilt app in \`app/public/verticals/${CUSTOMER}-app/\` (served at \`${APP_WEB_PATH}\`, alias \`/capitaliq\`); do not edit the build`,
  '',
  'Every index the Global Indices widget lists must load its detail. Europe and Asia rows load today;',
  'check which Americas rows fail before changing anything.',
  'Fix the data mismatch at its source, make `buildIndexDetail` fail with a descriptive error for a ticker',
  'it cannot resolve instead of dereferencing undefined, and add a test that every `INDICES` ticker has a listing.',
  `Run \`npx jest tests/${CUSTOMER}-index-detail.test.js --runInBand\` and \`npm run lint\`.`,
  `Verify every Americas, Europe and Asia row at \`${APP_WEB_PATH}\` switches the price chart without an error toast.`,
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function marketStatus(timezone) {
  const hour = Number(new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', hourCycle: 'h23', timeZone: timezone,
  }).format(new Date()));
  return hour >= 9 && hour < 16 ? 'Open' : 'Closed';
}

function buildIndexDetail(index) {
  const listing = LISTINGS[index.ticker];
  return {
    ticker: index.ticker,
    name: index.name,
    region: index.region,
    exchange: listing.exchange,
    timezone: listing.timezone,
    currency: listing.currency,
    constituents: listing.constituents,
    provider: listing.provider,
    marketStatus: marketStatus(listing.timezone),
  };
}

/**
 * Resolve the hub user's email to a Devin user id when the page could not
 * forward one. Returns '' when nobody matches.
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

function raiseIncident(error, index, requestId, identity) {
  const tags = {
    route: ROUTE,
    service: SERVICE,
    widget: 'global-indices',
    ticker: index.ticker,
    region: index.region,
    scenario: SCENARIO,
  };

  Sentry.captureException(error, {
    tags: { ...tags, alert_path: 'instant' },
    extra: { requestId, index },
  });

  const devinEmail = identity.devinEmail || OWNER.email;
  const devinOrgId = identity.devinOrgId
    || getCustomerConfig(CUSTOMER).devinOrgId || process.env.DEVIN_ORG_ID || '';

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: `app/services/verticals/${CUSTOMER}.js \u2014 buildIndexDetail`,
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId,
    devinEmail,
    devinOrgId: devinOrgId || undefined,
    slackMemberIdFallback: OWNER.slackMemberId,
    service: SERVICE,
    verticalLabel: 'S&P Capital IQ Pro',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: { requestId, index },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  });

  const userIdPromise = !identity.devinUserId && devinOrgId
    ? resolveUserIdByEmail(devinEmail, devinOrgId)
    : Promise.resolve(identity.devinUserId);

  return userIdPromise
    .then((userId) => raiseAlert(userId || undefined))
    .catch((alertError) => {
      logger.error('Failed to create Devin session for Capital IQ index detail error', {
        error: alertError.message,
        requestId,
      });
    });
}

/**
 * Load the detail card for a Global Indices row. A failure is captured to
 * Sentry and raised as a Slack alert + Devin session before it is rethrown.
 */
async function loadIndexDetail(data) {
  const startTime = Date.now();
  const requestId = `CIQ-${uuidv4().slice(0, 8).toUpperCase()}`;
  const ticker = clip(data.ticker, 32);
  const index = INDICES.find((entry) => entry.ticker === ticker);
  if (!index) throw validationError(`Unknown index "${ticker}".`, 'UNKNOWN_INDEX');

  logger.info('Loading Capital IQ index detail', {
    requestId, ticker, region: index.region, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 150 + Math.random() * 150));
    const detail = buildIndexDetail(index);
    incrementMetric('global_indices.detail_success', { route: ROUTE, region: index.region });
    recordTiming('global_indices.detail_latency', Date.now() - startTime, { route: ROUTE });
    return { success: true, requestId, detail };
  } catch (error) {
    incrementMetric('global_indices.detail_failure', {
      route: ROUTE, region: index.region, errorClass: error.name,
    });
    recordTiming('global_indices.detail_latency', Date.now() - startTime, { route: ROUTE, error: 'true' });
    logger.error('Capital IQ index detail failed', {
      requestId,
      ticker,
      region: index.region,
      error: error.message,
      errorClass: error.name,
      service: SERVICE,
    });

    error.sessionPromise = raiseIncident(error, index, requestId, {
      devinUserId: clip(data.devinUserId, 128),
      devinEmail: clip(data.devinEmail, 128),
      devinOrgId: clip(data.devinOrgId, 128),
    });
    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  ROUTE,
  SERVICE,
  APP_WEB_PATH,
  SCENARIO,
  OWNER,
  REMEDIATION_DIRECTIVE,
  buildIndexDetail,
  loadIndexDetail,
};
