/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.NOURISH_SLACK_MEMBER_ID || 'U08S7AVJ478';

const SERVICE = 'customer-53cfb2d5-coverage-check';
const ROUTE = '/api/53cfb2d5/coverage-check';

const LATENCY_SLO = { budgetMs: 3000 };
const ELIGIBILITY_POLICY = { latencyMs: [450, 550] };

const US_STATES = [
  'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS',
  'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC',
  'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
];

// Blue Cross Blue Shield is a federation of independent regional plans, so a
// BCBS member can only be verified by asking each plan in the directory.
// Directory order is the payer-routing priority used to break overlaps.
const BCBS_PLAN_DIRECTORY = [
  { id: 'anthem', label: 'Anthem Blue Cross Blue Shield', payerId: '00227', states: ['CA', 'CO', 'CT', 'GA', 'IN', 'KY', 'ME', 'MO', 'NV', 'NH', 'NY', 'OH', 'VA', 'WI'], copayUsd: 0, visitsPerYear: 12 },
  { id: 'highmark', label: 'Highmark Blue Cross Blue Shield', payerId: '54771', states: ['PA', 'DE', 'WV', 'NY'], copayUsd: 0, visitsPerYear: 10 },
  { id: 'regence', label: 'Regence BlueCross BlueShield', payerId: '00851', states: ['OR', 'WA', 'ID', 'UT'], copayUsd: 0, visitsPerYear: 12 },
  { id: 'carefirst', label: 'CareFirst BlueCross BlueShield', payerId: '00580', states: ['MD', 'DC', 'VA'], copayUsd: 0, visitsPerYear: 8 },
  { id: 'wellmark', label: 'Wellmark Blue Cross Blue Shield', payerId: '88848', states: ['IA', 'SD'], copayUsd: 0, visitsPerYear: 10 },
  { id: 'florida-blue', label: 'Florida Blue', payerId: '00590', states: ['FL'], copayUsd: 0, visitsPerYear: 12 },
  { id: 'bcbsil', label: 'Blue Cross and Blue Shield of Illinois', payerId: '00621', states: ['IL', 'MT', 'NM', 'OK'], copayUsd: 0, visitsPerYear: 12 },
  { id: 'horizon', label: 'Horizon Blue Cross Blue Shield of New Jersey', payerId: '22099', states: ['NJ'], copayUsd: 0, visitsPerYear: 10 },
  { id: 'excellus', label: 'Excellus BlueCross BlueShield', payerId: '00800', states: ['NY'], copayUsd: 0, visitsPerYear: 8 },
  { id: 'premera', label: 'Premera Blue Cross', payerId: '00430', states: ['WA', 'AK'], copayUsd: 0, visitsPerYear: 12 },
  { id: 'ibx', label: 'Independence Blue Cross', payerId: '54704', states: ['PA'], copayUsd: 0, visitsPerYear: 10 },
  { id: 'bcbsm', label: 'Blue Cross Blue Shield of Michigan', payerId: '00710', states: ['MI'], copayUsd: 0, visitsPerYear: 12 },
  { id: 'bcbsnc', label: 'Blue Cross NC', payerId: '00602', states: ['NC'], copayUsd: 0, visitsPerYear: 10 },
  { id: 'bcbstx', label: 'Blue Cross and Blue Shield of Texas', payerId: '84980', states: ['TX'], copayUsd: 0, visitsPerYear: 12 },
];

const ALL_STATES = US_STATES;

const CARRIERS = {
  bcbs: { label: 'Blue Cross Blue Shield', plans: BCBS_PLAN_DIRECTORY },
  aetna: { label: 'Aetna', plans: [{ id: 'aetna', label: 'Aetna Open Access', payerId: '60054', states: ALL_STATES, copayUsd: 0, visitsPerYear: 12 }] },
  cigna: { label: 'Cigna', plans: [{ id: 'cigna', label: 'Cigna Open Access Plus', payerId: '62308', states: ALL_STATES, copayUsd: 0, visitsPerYear: 10 }] },
  uhc: { label: 'UnitedHealthcare', plans: [{ id: 'uhc', label: 'UnitedHealthcare Choice Plus', payerId: '87726', states: ALL_STATES, copayUsd: 0, visitsPerYear: 12 }] },
  medicare: { label: 'Medicare', plans: [{ id: 'medicare', label: 'Medicare Part B (MNT)', payerId: 'CMS', states: ALL_STATES, copayUsd: 0, visitsPerYear: 5 }] },
  humana: { label: 'Humana', plans: [{ id: 'humana', label: 'Humana Medicare Advantage', payerId: '61101', states: ALL_STATES, copayUsd: 0, visitsPerYear: 6 }] },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Nourish insurance coverage check:',
  '- Service: `app/services/verticals/53cfb2d5.js`',
  '- Route: `app/routes/verticals/53cfb2d5.js`',
  '- Page: `app/public/verticals/53cfb2d5.html` (served at `/nourish`)',
  '- Test: `tests/53cfb2d5-coverage-check.test.js`',
  '',
  'Coverage checks for the default Blue Cross Blue Shield carrier succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency (start with `collectPlanEligibility`) and fix it.',
  'Do not raise or remove the latency budget, the breach alert, or the simulated per-plan eligibility latency.',
  'Preserve the response shape for every carrier, including the plan directory order of `planResponses` and the first-active-plan tie-break.',
  'Run `npx jest tests/53cfb2d5-coverage-check.test.js --runInBand` and `npm run lint`.',
  'Verify the default coverage check at `/nourish` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashMember(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Simulated 270/271 eligibility round-trip to one payer. */
async function checkPlanEligibility(member, plan) {
  const [min, max] = ELIGIBILITY_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const active = plan.states.includes(member.state);
  const hash = hashMember(`${member.lastName}:${member.dateOfBirth}:${plan.payerId}`);

  return {
    planId: plan.id,
    plan: plan.label,
    payerId: plan.payerId,
    status: active ? 'active' : 'no_member_record',
    memberId: active ? `${plan.id.slice(0, 3).toUpperCase()}${String(hash % 1000000000).padStart(9, '0')}` : null,
    copayUsd: active ? plan.copayUsd : null,
    visitsPerYear: active ? plan.visitsPerYear : null,
  };
}

/**
 * Ask every plan for the carrier in directory order; selectCoverage picks the
 * first active plan in that order.
 */
async function collectPlanEligibility(member, plans) {
  const responses = [];
  for (const plan of plans) {
    responses.push(await checkPlanEligibility(member, plan));
  }
  return responses;
}

function selectCoverage(responses) {
  return responses.find((response) => response.status === 'active') || null;
}

function validationError(message) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = 'COVERAGE_DETAILS_INVALID';
  error.statusCode = 400;
  return error;
}

function validateCoverageRequest(data) {
  const namePattern = /^[\p{L}][\p{L}' .-]{0,49}$/u;
  const dobMatch = /^(\d{4})-(\d{2})-(\d{2})$/.exec(data.dateOfBirth);
  let validDob = false;
  if (dobMatch) {
    const dob = new Date(`${data.dateOfBirth}T00:00:00Z`);
    const ageYears = (Date.now() - dob.getTime()) / (365.25 * 24 * 3600 * 1000);
    validDob = !Number.isNaN(dob.getTime())
      && dob.toISOString().slice(0, 10) === data.dateOfBirth
      && ageYears >= 0 && ageYears <= 120;
  }

  if (!namePattern.test(data.firstName) || !namePattern.test(data.lastName)
    || !validDob || !US_STATES.includes(data.state) || !Object.hasOwn(CARRIERS, data.carrier)) {
    throw validationError('Enter your name, date of birth, state and insurance carrier.');
  }
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, plansChecked, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      carrier: data.carrier,
      state: data.state,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      plansChecked,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/53cfb2d5.js — collectPlanEligibility',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Nourish Coverage Check',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '53cfb2d5',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'carrier', value: data.carrier },
      { key: 'state', value: data.state },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      plansChecked,
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
    logger.error('Failed to create Devin session for Nourish coverage-check latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

function textField(value, fallback) {
  return String(value === undefined || value === null ? fallback : value).trim();
}

async function checkCoverage(data = {}) {
  const startTime = Date.now();
  const checkId = `NRSH-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    firstName: textField(requestData.firstName, 'Jordan'),
    lastName: textField(requestData.lastName, 'Rivera'),
    dateOfBirth: textField(requestData.dateOfBirth, '1988-04-12'),
    state: textField(requestData.state, 'TX').toUpperCase(),
    carrier: textField(requestData.carrier, 'bcbs').toLowerCase(),
  };

  validateCoverageRequest(normalized);

  const carrier = CARRIERS[normalized.carrier];

  logger.info('Checking Nourish insurance coverage', {
    checkId,
    carrier: normalized.carrier,
    state: normalized.state,
    plansToCheck: carrier.plans.length,
    service: SERVICE,
    route: ROUTE,
  });

  const planResponses = await collectPlanEligibility(normalized, carrier.plans);
  const coverage = selectCoverage(planResponses);
  const durationMs = Date.now() - startTime;

  incrementMetric('coverage_check.success', {
    route: ROUTE,
    carrier: normalized.carrier,
    covered: String(Boolean(coverage)),
  });
  recordTiming('coverage_check.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('coverage_check.latency_budget_breach', {
      route: ROUTE,
      carrier: normalized.carrier,
    });
    logger.warn('Nourish coverage check exceeded latency budget — triggering Devin', {
      checkId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      plansChecked: planResponses.length,
      carrier: normalized.carrier,
      state: normalized.state,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: checkId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      plansChecked: planResponses.length,
      data: normalized,
    }));
  }

  return {
    success: true,
    checkId,
    patient: {
      firstName: normalized.firstName,
      lastName: normalized.lastName,
      state: normalized.state,
    },
    carrier: {
      key: normalized.carrier,
      label: carrier.label,
    },
    covered: Boolean(coverage),
    coverage: coverage ? {
      planId: coverage.planId,
      plan: coverage.plan,
      payerId: coverage.payerId,
      memberId: coverage.memberId,
      copayUsd: coverage.copayUsd,
      visitsPerYear: coverage.visitsPerYear,
    } : null,
    plansChecked: planResponses.length,
    planResponses,
    durationMs,
  };
}

module.exports = {
  checkCoverage,
  selectCoverage,
  CARRIERS,
  BCBS_PLAN_DIRECTORY,
  US_STATES,
  ELIGIBILITY_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
