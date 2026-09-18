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
 * client builds digital asset deposit instructions in the browser and POSTs
 * failures to /api/9bfabd45/error so the Slack alert + Devin session are raised
 * under the app identity without a Sentry webhook round-trip.
 */
const CUSTOMER = '9bfabd45';
const APP_SERVICE = `customer-${CUSTOMER}-web`;
const APP_PROJECT = 'nexen-custody';
const APP_RELEASE = 'nexen-custody@1.0.0';
const APP_SOURCE_PREFIX = 'nexen-custody/';
const APP_REPO = 'github.com/COG-GTM/bny';
const APP_WEB_PATH = '/9bfabd45/app';
const SCENARIO = 'digital-asset-custody-deposit';

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
  'The failing code path is the Digital Asset Custody deposit instruction:',
  '- Custody rule registry: `frontend/src/domain/digitalAssetCustody.ts` (`LAUNCHED_MARKETS`,',
  '  the safekeeping arrangement registered per market) and its Java mirror',
  '  `backend/.../repository/CustodyFixtures.java` (`DIGITAL_ASSET_CUSTODY_RULES`)',
  '- Fixtures: `frontend/src/api/fixtures.ts` (accounts and their digital asset holdings)',
  '- Crash site: `buildDepositInstruction` in `frontend/src/domain/digitalAssetCustody.ts`,',
  '  mirrored by `backend/.../service/DigitalAssetCustodyService.java#instructDeposit`',
  '- Entry: `frontend/src/pages/AccountsPage.tsx` ("Instruct digital asset deposit")',
  '',
  `The alert came from the hosted build at \`https://devindemos.com${APP_WEB_PATH}\` (served from`,
  `\`app/public/verticals/${CUSTOMER}-app/\` in \`COG-GTM/event-driven-devin\`), running the frontend's`,
  'mock client — no backend is deployed.',
  '',
  'Steps:',
  '1. Reproduce first: `cd frontend && npm install && npm run dev`, open the Accounts screen,',
  '   select the Frankfurt (DE) or Paris (FR) account and click "Instruct digital asset deposit" —',
  '   confirm the "deposit instruction unavailable" notice. Note the test suites are GREEN on the',
  '   broken baseline: nothing asserts that every market holding digital assets has a custody rule.',
  '2. Fix the data, not just the crash site: register the missing markets in the custody rule',
  '   registry (both the TypeScript and Java mirrors) with accurate safekeeping details, and make',
  '   `buildDepositInstruction` / `instructDeposit` reject an unregistered market explicitly',
  '   (typed error surfaced to the UI) instead of dereferencing undefined.',
  '3. Add the prevention control: a frontend test asserting every market with digital asset',
  '   holdings has a `digitalAssetCustodyRules` entry, a backend test for the same invariant over',
  '   `DIGITAL_ASSET_CUSTODY_RULES`, and coverage for the unregistered-market path.',
  '   `npx tsc -b`, `npx oxlint`, `npm run build` and `./gradlew test` must pass.',
  `   Do not change the incident reporting identity in \`frontend/src/lib/incident.ts\` (\`${APP_SERVICE}\`).`,
  '4. Re-run the reproduction on the fix commit and confirm the DE and FR accounts now render a',
  '   deposit instruction with the safekeeping entity, settlement network and cut-off.',
  '5. Open a pull request against `main`, request Devin Review, and STOP for human approval.',
  `6. After approval, refresh the hosted build: \`npm run build\` with base \`${APP_WEB_PATH}/\` on the`,
  `   fix commit, copy \`frontend/dist/\` into \`app/public/verticals/${CUSTOMER}-app/\` in`,
  `   \`COG-GTM/event-driven-devin\`, and open a PR there so \`${APP_WEB_PATH}\` picks up the fix.`,
].join('\n');

function clip(value, max) {
  const text = value == null ? '' : String(value);
  return text.length > max ? text.slice(0, max) : text;
}

/** Keep only flat scalar report metadata so Sentry/Slack payloads stay bounded. */
function sanitizeReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return {};
  const out = {};
  for (const [key, value] of Object.entries(report)) {
    if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) {
      out[clip(key, 64)] = typeof value === 'string' ? clip(value, 256) : value;
    }
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
  const screen = clip(report.screen || 'custody_holdings', 64);
  const action = clip(report.action || 'instruct_digital_asset_deposit', 64);
  const accountNumber = clip(report.accountNumber || 'unknown', 64);
  const clientName = clip(report.clientName || 'unknown', 128);
  const market = clip(report.market || 'unknown', 8);
  const errorType = clip(report.errorType || 'Error', 128);
  const errorMessage = clip(report.errorMessage || 'Digital asset deposit instruction failed', 512);
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

  incrementMetric('digital_asset_deposit.failure', {
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

  Sentry.captureException(error, {
    tags: { ...tags, alert_path: 'instant' },
    extra: { reference, release, environment, report: custodyReport },
  });

  const raiseAlert = (devinUserId) => createSessionAndAlert({
    issueTitle: `${errorType}: ${errorMessage}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${APP_PROJECT}&query=is%3Aunresolved`,
    culprit: 'frontend/src/domain/digitalAssetCustody.ts \u2014 buildDepositInstruction',
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
