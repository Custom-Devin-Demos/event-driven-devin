/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.CONIFER_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-85bedc75-ar-assessment';
const ROUTE = '/api/85bedc75/ar-assessment';

const LATENCY_SLO = { budgetMs: 3000 };
const PAYER_FEED_POLICY = { latencyMs: [450, 550] };
const CONIFER_TARGET_AR_DAYS = 47;

const PAYERS = {
  medicare_a: { label: 'Medicare Part A (Novitas JH)', line: 'Medicare', mixPct: 18 },
  medicare_adv: { label: 'Medicare Advantage', line: 'Medicare', mixPct: 12 },
  tx_medicaid: { label: 'Texas Medicaid (TMHP)', line: 'Medicaid', mixPct: 7 },
  medi_cal: { label: 'California Medi-Cal', line: 'Medicaid', mixPct: 5 },
  unitedhealthcare: { label: 'UnitedHealthcare', line: 'Commercial', mixPct: 11 },
  aetna: { label: 'Aetna', line: 'Commercial', mixPct: 7 },
  cigna: { label: 'Cigna Healthcare', line: 'Commercial', mixPct: 6 },
  anthem: { label: 'Anthem Blue Cross', line: 'Commercial', mixPct: 6 },
  bcbstx: { label: 'Blue Cross Blue Shield of Texas', line: 'Commercial', mixPct: 9 },
  humana: { label: 'Humana', line: 'Medicare', mixPct: 5 },
  ambetter: { label: 'Ambetter (Centene)', line: 'Marketplace', mixPct: 4 },
  molina: { label: 'Molina Healthcare', line: 'Medicaid', mixPct: 4 },
  tricare: { label: 'TRICARE East', line: 'Government', mixPct: 3 },
  self_pay: { label: 'Self-Pay & Patient Responsibility', line: 'Self-Pay', mixPct: 3 },
};

const ALL_PAYERS = Object.keys(PAYERS);

const SCOPE_OPTIONS = {
  all: { label: 'All contracted payers', payers: ALL_PAYERS },
  medicare_a: { label: 'Medicare Part A only', payers: ['medicare_a'] },
  unitedhealthcare: { label: 'UnitedHealthcare only', payers: ['unitedhealthcare'] },
  bcbstx: { label: 'BCBS of Texas only', payers: ['bcbstx'] },
  self_pay: { label: 'Self-pay only', payers: ['self_pay'] },
};

const FACILITY_TYPES = {
  hospital: { label: 'Hospital & Health System', claimsPerMillion: 410, baseDenialPct: 11.2 },
  physician: { label: 'Physician Practice', claimsPerMillion: 1650, baseDenialPct: 8.4 },
  employer: { label: 'Employer & Union', claimsPerMillion: 980, baseDenialPct: 6.1 },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Conifer Health revenue cycle (A/R) assessment request:',
  '- Service: `app/services/verticals/85bedc75.js`',
  '- Route: `app/routes/verticals/85bedc75.js`',
  '- Page: `app/public/verticals/85bedc75.html` (served at `/conifer`)',
  '- Test: `tests/85bedc75-ar-assessment.test.js`',
  '',
  'Assessments with the default "All contracted payers" scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'The culprit is `collectPayerRemittances` in the service. Find the root cause of the latency and fix it.',
  'Do not raise or remove `LATENCY_SLO.budgetMs`, the breach alert, or the simulated per-payer feed latency (`PAYER_FEED_POLICY`).',
  'Preserve the response payload for every scope, including the payer order in `payerResults` (contracted payer order) and the summary math.',
  'Run `npx jest tests/85bedc75-ar-assessment.test.js --runInBand` and `npm run lint`.',
  'Verify the default assessment at `/conifer` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashKey(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function round1(value) {
  return Math.round(value * 10) / 10;
}

async function fetchPayerRemittance(payerKey, facilityKey, annualNprMillions) {
  const [min, max] = PAYER_FEED_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const payer = PAYERS[payerKey];
  const facility = FACILITY_TYPES[facilityKey];
  const hash = hashKey(`${payerKey}:${facilityKey}`);
  const payerNprMillions = (annualNprMillions * payer.mixPct) / 100;
  const claims = Math.max(1, Math.round((payerNprMillions * facility.claimsPerMillion) / 12));
  const denialRatePct = round1(facility.baseDenialPct + ((hash % 61) - 25) / 10);
  const deniedClaims = Math.round((claims * denialRatePct) / 100);
  const arDays = 41 + ((hash >>> 7) % 29);
  const openArCents = Math.round((payerNprMillions * 100000000 * arDays) / 365);
  const recoverablePct = 52 + ((hash >>> 13) % 21);
  const recoverableCents = Math.round(
    ((payerNprMillions * 100000000) / 12) * (denialRatePct / 100) * (recoverablePct / 100),
  );

  return {
    payer: payerKey,
    label: payer.label,
    line: payer.line,
    claims,
    deniedClaims,
    denialRatePct,
    arDays,
    openArCents,
    recoverableCents,
  };
}

/**
 * Pull the latest 835 remittance / denial snapshot from each payer's
 * clearinghouse feed, in contracted payer order.
 */
async function collectPayerRemittances(payerKeys, facilityKey, annualNprMillions) {
  const results = [];
  for (const payerKey of payerKeys) {
    results.push(await fetchPayerRemittance(payerKey, facilityKey, annualNprMillions));
  }
  return results;
}

function summarize(payerResults) {
  const totalClaims = payerResults.reduce((sum, r) => sum + r.claims, 0);
  const deniedClaims = payerResults.reduce((sum, r) => sum + r.deniedClaims, 0);
  const openArCents = payerResults.reduce((sum, r) => sum + r.openArCents, 0);
  const recoverableCents = payerResults.reduce((sum, r) => sum + r.recoverableCents, 0);
  const weightedArDays = openArCents === 0
    ? 0
    : round1(payerResults.reduce((sum, r) => sum + r.arDays * r.openArCents, 0) / openArCents);
  const projectedArDays = Math.min(weightedArDays, CONIFER_TARGET_AR_DAYS);
  const cashAccelerationCents = weightedArDays === 0
    ? 0
    : Math.round((openArCents * (weightedArDays - projectedArDays)) / weightedArDays);
  const highestDenial = payerResults.reduce(
    (worst, r) => (!worst || r.denialRatePct > worst.denialRatePct ? r : worst),
    null,
  );

  return {
    payersAssessed: payerResults.length,
    totalClaims,
    deniedClaims,
    denialRatePct: totalClaims === 0 ? 0 : round1((deniedClaims / totalClaims) * 100),
    weightedArDays,
    projectedArDays,
    openArCents,
    recoverableCents,
    cashAccelerationCents,
    highestDenialPayer: highestDenial ? highestDenial.label : null,
  };
}

function validateAssessmentRequest(data) {
  const validOrganization = data.organization.length >= 2 && data.organization.length <= 120;
  const validFacility = Object.hasOwn(FACILITY_TYPES, data.facilityType);
  const validNpr = Number.isInteger(data.annualNprMillions)
    && data.annualNprMillions >= 1 && data.annualNprMillions <= 50000;
  const validScope = Object.hasOwn(SCOPE_OPTIONS, data.scope);

  if (!validOrganization || !validFacility || !validNpr || !validScope) {
    const error = new Error('Enter a valid organization, facility type, annual net patient revenue and payer scope.');
    error.name = 'ValidationError';
    error.code = 'ASSESSMENT_DETAILS_INVALID';
    error.statusCode = 400;
    throw error;
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, payersPolled, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      scope: data.scope,
      facility_type: data.facilityType,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      payersPolled,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/85bedc75.js — collectPayerRemittances',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Conifer Health Revenue Cycle Assessment',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '85bedc75',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'scope', value: data.scope },
      { key: 'facility_type', value: data.facilityType },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      payersPolled,
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
    logger.error('Failed to create Devin session for Conifer Health A/R assessment latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function runRevenueCycleAssessment(data = {}) {
  const startTime = Date.now();
  const assessmentId = `CHS-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    organization: String(requestData.organization === undefined ? 'Dartmouth Health' : requestData.organization).trim(),
    facilityType: String(requestData.facilityType || 'hospital').trim().toLowerCase(),
    annualNprMillions: Number(requestData.annualNprMillions === undefined || requestData.annualNprMillions === ''
      ? 850
      : requestData.annualNprMillions),
    scope: String(requestData.scope || 'all').trim().toLowerCase(),
  };

  validateAssessmentRequest(normalized);

  const scope = SCOPE_OPTIONS[normalized.scope];
  const facility = FACILITY_TYPES[normalized.facilityType];

  logger.info('Running Conifer Health revenue cycle assessment', {
    assessmentId,
    organization: normalized.organization,
    facilityType: normalized.facilityType,
    annualNprMillions: normalized.annualNprMillions,
    scope: normalized.scope,
    service: SERVICE,
    route: ROUTE,
  });

  const payerResults = await collectPayerRemittances(
    scope.payers,
    normalized.facilityType,
    normalized.annualNprMillions,
  );
  const summary = summarize(payerResults);
  const durationMs = Date.now() - startTime;

  incrementMetric('ar_assessment.success', {
    route: ROUTE,
    scope: normalized.scope,
    facility_type: normalized.facilityType,
  });
  recordTiming('ar_assessment.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('ar_assessment.latency_budget_breach', {
      route: ROUTE,
      scope: normalized.scope,
      facility_type: normalized.facilityType,
    });
    logger.warn('Conifer Health A/R assessment exceeded latency budget — triggering Devin', {
      assessmentId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      payersPolled: payerResults.length,
      scope: normalized.scope,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: assessmentId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      payersPolled: payerResults.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    assessmentId,
    organization: normalized.organization,
    facilityType: {
      key: normalized.facilityType,
      label: facility.label,
    },
    annualNprMillions: normalized.annualNprMillions,
    scope: {
      key: normalized.scope,
      label: scope.label,
    },
    summary,
    payerResults,
    benchmarkArDays: CONIFER_TARGET_AR_DAYS,
    currency: 'USD',
    durationMs,
  };
}

module.exports = {
  runRevenueCycleAssessment,
  collectPayerRemittances,
  summarize,
  PAYERS,
  SCOPE_OPTIONS,
  FACILITY_TYPES,
  PAYER_FEED_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
