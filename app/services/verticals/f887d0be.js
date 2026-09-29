/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.WAYSTONE_SLACK_MEMBER_ID || 'U08S7AVJ478';

const SERVICE = 'customer-f887d0be-enquiry';
const ROUTE = '/api/f887d0be/enquiry';

/**
 * Screening-partner call policy — how many watchlist checks may be in flight
 * at once against the screening partner, and the observed per-call latency.
 *
 * Change log:
 *  - enquiry-intake@1.6.0: concurrency 12.
 *  - enquiry-intake@1.6.1: an upstream rate-limit incident (ComplianceOps
 *    KYC-2291) dropped concurrency 12 → 1 as a temporary workaround while the
 *    screening partner's per-client throttling was misconfigured.
 *  - KYC-2291 is closed: the partner raised the per-client ceiling to 24
 *    concurrent calls, so any value up to 24 is sanctioned and needs no
 *    further ComplianceOps sign-off; the shipped default was never raised back.
 */
const SCREENING_POLICY = {
  concurrency: Number(process.env.WAYSTONE_SCREENING_CONCURRENCY) > 0
    ? Math.max(1, Math.floor(Number(process.env.WAYSTONE_SCREENING_CONCURRENCY)))
    : 1,
  latencyMs: [220, 300],
};

const LATENCY_SLO = { budgetMs: 3000 };

const SERVICES = {
  manco: { label: 'AIFMD and UCITS Management Company Solutions', requiresScreening: true },
  compliance: { label: 'Compliance Solutions', requiresScreening: true },
  administration: { label: 'Administration Solutions', requiresScreening: false },
  cayman: { label: 'Cayman Solutions', requiresScreening: false },
  etfs: { label: 'Waystone ETFs', requiresScreening: false },
};

const DOMICILES = {
  ireland: { label: 'Ireland', team: 'Regulated Fund Solutions — Dublin' },
  luxembourg: { label: 'Luxembourg', team: 'Regulated Fund Solutions — Luxembourg' },
  united_kingdom: { label: 'United Kingdom', team: 'UK ACD Solutions — London' },
  cayman_islands: { label: 'Cayman Islands', team: 'Cayman Solutions — Grand Cayman' },
  switzerland: { label: 'Switzerland', team: 'Swiss Fund Solutions — Zurich' },
};

const WATCHLISTS = [
  'OFAC SDN',
  'OFAC Consolidated',
  'UN Security Council',
  'EU Consolidated',
  'UK OFSI',
  'Swiss SECO',
  'Canada SEMA',
  'Australia DFAT',
  'HKMA',
  'MAS',
  'CIMA Cayman',
  'CBI Ireland',
  'CSSF Luxembourg',
  'Interpol Red Notices',
  'World Bank Debarment',
  'FATF High-Risk Jurisdictions',
  'PEP Database',
  'Adverse Media',
];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Waystone enquiry request:',
  '- Service: `app/services/verticals/f887d0be.js`',
  '- Route: `app/routes/verticals/f887d0be.js`',
  '- Page: `app/public/verticals/f887d0be.html` (served at `/waystone`)',
  '',
  'Requests succeed but take ~10s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated dependency latency.',
  'Preserve the response payload for every option.',
  'Run `npx jest tests/f887d0be-enquiry.test.js --runInBand` and `npm run lint`.',
  'Verify the default enquiry at `/waystone` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validateEnquiry(data) {
  if (!data.firstName || !data.lastName || !data.email || !data.company) {
    const error = new Error('Complete your contact details so our team can follow up.');
    error.name = 'ValidationError';
    error.code = 'CONTACT_DETAILS_REQUIRED';
    error.statusCode = 400;
    throw error;
  }

  if (!Object.hasOwn(SERVICES, data.service || 'manco') || !Object.hasOwn(DOMICILES, data.domicile || '')) {
    const error = new Error('Select a valid service and fund domicile.');
    error.name = 'ValidationError';
    error.code = 'ENQUIRY_DETAILS_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

/**
 * Screen a single party against a single watchlist. Latency mirrors the
 * observed distribution on the screening partner endpoint.
 */
async function screenPartyAgainstList(list, party) {
  const [min, max] = SCREENING_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
  return { list, party, match: false };
}

/**
 * Screen every party against every watchlist. Calls go through the screening
 * partner in batches of SCREENING_POLICY.concurrency.
 */
async function screenCounterparties(parties) {
  const jobs = [];
  for (const party of parties) {
    for (const list of WATCHLISTS) {
      jobs.push({ party, list });
    }
  }

  const results = [];
  const concurrency = Math.max(1, Math.floor(SCREENING_POLICY.concurrency) || 1);
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    results.push(...await Promise.all(
      batch.map((job) => screenPartyAgainstList(job.list, job.party)),
    ));
  }

  return {
    required: true,
    lists: WATCHLISTS.length,
    parties: parties.length,
    checks: results.length,
    cleared: results.every((r) => !r.match),
  };
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, callCount, concurrency, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      enquiryService: data.service,
      domicile: data.domicile,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      callCount,
      concurrency,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/f887d0be.js — screenCounterparties',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Waystone Enquiry',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'f887d0be',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'enquiry_service', value: data.service },
      { key: 'domicile', value: data.domicile },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      callCount,
      concurrency,
    },
    level: 'warning',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for Waystone enquiry latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function submitEnquiry(data) {
  const startTime = Date.now();
  const reference = `WAY-${uuidv4().slice(0, 8).toUpperCase()}`;

  data = { ...data, service: data.service || 'manco' };

  validateEnquiry(data);

  const service = SERVICES[data.service];
  const domicile = DOMICILES[data.domicile];

  logger.info('Submitting Waystone enquiry', {
    reference,
    service: data.service,
    domicile: data.domicile,
    requiresScreening: service.requiresScreening,
    appService: SERVICE,
    route: ROUTE,
  });

  let screening;
  let callCount = 0;
  if (service.requiresScreening) {
    const parties = [data.company, `${data.firstName} ${data.lastName}`];
    screening = await screenCounterparties(parties);
    callCount = screening.checks;
  } else {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 60));
    screening = { required: false };
  }

  const durationMs = Date.now() - startTime;

  incrementMetric('enquiry.success', {
    route: ROUTE,
    enquiryService: data.service,
    domicile: data.domicile,
  });
  recordTiming('enquiry.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('enquiry.latency_budget_breach', {
      route: ROUTE,
      enquiryService: data.service,
      domicile: data.domicile,
    });
    logger.warn('Waystone enquiry exceeded latency budget', {
      reference,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      callCount,
      concurrency: SCREENING_POLICY.concurrency,
      parties: screening.parties,
      lists: screening.lists,
      appService: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: reference,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      callCount,
      concurrency: SCREENING_POLICY.concurrency,
      data,
    }));
  }

  return {
    success: true,
    reference,
    status: 'received',
    service: { key: data.service, label: service.label },
    domicile: { key: data.domicile, label: domicile.label },
    routing: { team: domicile.team, responseSlaHours: 24 },
    screening,
    durationMs,
  };
}

module.exports = {
  submitEnquiry,
  SERVICES,
  DOMICILES,
  WATCHLISTS,
  SCREENING_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
