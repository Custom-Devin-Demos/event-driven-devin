/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.CAREVISO_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-2717ffdc-demo-request';
const ROUTE = '/api/2717ffdc/demo-requests';

const LATENCY_SLO = { budgetMs: 3000 };
const PAYER_LOOKUP_POLICY = { latencyMs: [450, 550] };

const BUSINESS_TYPES = [
  { id: 'physician-office', label: 'Physician office/clinic' },
  { id: 'laboratory-rcm', label: 'Laboratory / RCM' },
  { id: 'pharma-hub', label: 'Pharma Manufacturer/Hub' },
  { id: 'other-provider', label: 'Other Healthcare service provider' },
];

const PREFILL = {
  firstName: 'Dana',
  lastName: 'Whitaker',
  email: 'dana.whitaker@blueridgecardiology.com',
  businessType: 'physician-office',
  message: "We're a 14-provider cardiology practice in Roanoke, VA spending about 30 staff hours a week on benefits verification and prior authorizations. We'd like a seeQer demo focused on benefits verification and patient cost estimates.",
};

const PAYERS = [
  'Aetna',
  'Anthem BCBS',
  'Cigna',
  'UnitedHealthcare',
  'Humana',
  'Medicare Part B',
  'Virginia Medicaid',
  'CareFirst BCBS',
  'Optima Health',
  'Sentara',
  'Kaiser Permanente',
  'Tricare',
  'Highmark',
  'Molina',
];

const PAYER_POLICY_PROFILES = {
  Aetna: { benefitsVerification: 'real-time', priorAuthCommon: true },
  'Anthem BCBS': { benefitsVerification: 'portal', priorAuthCommon: true },
  Cigna: { benefitsVerification: 'real-time', priorAuthCommon: true },
  UnitedHealthcare: { benefitsVerification: 'real-time', priorAuthCommon: true },
  Humana: { benefitsVerification: 'portal', priorAuthCommon: true },
  'Medicare Part B': { benefitsVerification: 'portal', priorAuthCommon: false },
  'Virginia Medicaid': { benefitsVerification: 'portal', priorAuthCommon: true },
  'CareFirst BCBS': { benefitsVerification: 'real-time', priorAuthCommon: true },
  'Optima Health': { benefitsVerification: 'portal', priorAuthCommon: true },
  Sentara: { benefitsVerification: 'real-time', priorAuthCommon: true },
  'Kaiser Permanente': { benefitsVerification: 'real-time', priorAuthCommon: false },
  Tricare: { benefitsVerification: 'portal', priorAuthCommon: true },
  Highmark: { benefitsVerification: 'real-time', priorAuthCommon: true },
  Molina: { benefitsVerification: 'portal', priorAuthCommon: true },
};

const REPRESENTATIVE_PAYERS = {
  'laboratory-rcm': 'Medicare Part B',
  'pharma-hub': 'UnitedHealthcare',
  'other-provider': 'Aetna',
};

const SOLUTION_CONSULTANTS = {
  'physician-office': {
    name: 'Morgan Reed',
    title: 'seeQer Solution Consultant',
    email: 'morgan.reed@careviso.com',
    region: 'Mid-Atlantic',
  },
  'laboratory-rcm': {
    name: 'Taylor Chen',
    title: 'seeQer Solution Consultant',
    email: 'taylor.chen@careviso.com',
    region: 'Northeast',
  },
  'pharma-hub': {
    name: 'Riley Torres',
    title: 'seeQer Solution Consultant',
    email: 'riley.torres@careviso.com',
    region: 'National',
  },
  'other-provider': {
    name: 'Jordan Kim',
    title: 'seeQer Solution Consultant',
    email: 'jordan.kim@careviso.com',
    region: 'West',
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Careviso seeQer benefits-verification demo request:',
  '- Service: `app/services/verticals/2717ffdc.js`',
  '- Route: `app/routes/verticals/2717ffdc.js`',
  '- Page: `app/public/verticals/2717ffdc.html` (served at `/careviso`)',
  '- Test: `tests/2717ffdc-demo-request.test.js`',
  '',
  'Default physician-office requests succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause in `buildPayerCoverageSnapshot` and `fetchPayerPolicyProfile`.',
  'Fix the sequential payer lookups with `Promise.all` while preserving payer order, the latency budget, breach alert, simulated per-call latency, and response shape.',
  'Run `npx jest tests/2717ffdc-demo-request.test.js --runInBand` and `npm run lint`.',
  'Open a fix pull request against `main`.',
].join('\n');

function createValidationError(message, code, requestId) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  error.requestId = requestId;
  return error;
}

function validateDemoRequest(data, requestId) {
  if (!data.firstName || !data.lastName) {
    throw createValidationError(
      'Enter your first and last name.',
      'CONTACT_DETAILS_REQUIRED',
      requestId,
    );
  }

  if (typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    throw createValidationError(
      'Enter a valid email address.',
      'INVALID_EMAIL',
      requestId,
    );
  }

  if (!BUSINESS_TYPES.some(({ id }) => id === data.businessType)) {
    throw createValidationError(
      'Select a valid business type.',
      'INVALID_BUSINESS_TYPE',
      requestId,
    );
  }
}

async function fetchPayerPolicyProfile(payer, businessType) {
  const [min, max] = PAYER_LOOKUP_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const profile = PAYER_POLICY_PROFILES[payer];
  if (!profile) {
    throw new Error(`No ${businessType} payer policy profile exists for ${payer}.`);
  }

  return {
    payer,
    benefitsVerification: profile.benefitsVerification,
    priorAuthCommon: profile.priorAuthCommon,
  };
}

async function buildPayerCoverageSnapshot(businessType) {
  const payers = businessType === 'physician-office'
    ? PAYERS
    : [REPRESENTATIVE_PAYERS[businessType]];
  const payerSnapshot = [];

  for (const payer of payers) {
    const profile = await fetchPayerPolicyProfile(payer, businessType);
    payerSnapshot.push(profile);
  }

  return payerSnapshot;
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, payersChecked, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      businessType: data.businessType,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      payersChecked,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/2717ffdc.js — buildPayerCoverageSnapshot',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Careviso seeQer Benefits Verification Demo',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '2717ffdc',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'business_type', value: data.businessType },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      payersChecked,
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
    logger.error('Failed to create Devin session for Careviso demo-request latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function submitDemoRequest(data = {}) {
  const startTime = Date.now();
  const requestId = `CVO-DM-${uuidv4().slice(0, 5).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    firstName: String(requestData.firstName || '').trim(),
    lastName: String(requestData.lastName || '').trim(),
    email: String(requestData.email || '').trim(),
    businessType: requestData.businessType === undefined
      ? 'physician-office'
      : requestData.businessType,
  };

  validateDemoRequest(normalized, requestId);

  logger.info('Routing Careviso seeQer demo request', {
    requestId,
    businessType: normalized.businessType,
    service: SERVICE,
    route: ROUTE,
  });

  const payerSnapshot = await buildPayerCoverageSnapshot(normalized.businessType);
  const durationMs = Date.now() - startTime;

  incrementMetric('demo_request.success', {
    route: ROUTE,
    businessType: normalized.businessType,
  });
  recordTiming('demo_request.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('demo_request.latency_budget_breach', {
      route: ROUTE,
      businessType: normalized.businessType,
    });
    logger.warn('Careviso demo request exceeded latency budget', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      payersChecked: payerSnapshot.length,
      businessType: normalized.businessType,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      payersChecked: payerSnapshot.length,
      data: normalized,
    }));
  }

  const businessType = BUSINESS_TYPES.find(({ id }) => id === normalized.businessType);
  const solutionConsultant = SOLUTION_CONSULTANTS[normalized.businessType];

  return {
    success: true,
    requestId,
    demoRequest: {
      id: requestId,
      status: 'scheduled',
      contact: {
        name: `${normalized.firstName} ${normalized.lastName}`,
        email: normalized.email,
      },
      businessType: {
        id: businessType.id,
        label: businessType.label,
      },
      solutionConsultant: {
        name: solutionConsultant.name,
        title: solutionConsultant.title,
        email: solutionConsultant.email,
        region: solutionConsultant.region,
      },
      payerSnapshot,
      nextStep: 'A seeQer solution consultant will reach out within 1 business day to schedule your demo.',
    },
    timing: {
      totalMs: durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      payersChecked: payerSnapshot.length,
    },
  };
}

module.exports = {
  submitDemoRequest,
  fetchPayerPolicyProfile,
  buildPayerCoverageSnapshot,
  BUSINESS_TYPES,
  PREFILL,
  PAYERS,
  PAYER_LOOKUP_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
