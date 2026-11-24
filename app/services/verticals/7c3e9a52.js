/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { claimLatencyAlert, releaseLatencyAlert } = require('../latency-alert-cooldown');

const SLACK_MEMBER_ID = process.env.NMI_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-7c3e9a52-talk-to-our-team';
const ROUTE = '/api/7c3e9a52/contact-requests';

const LATENCY_SLO = { budgetMs: 3000 };
const PROCESSOR_CHECK_POLICY = { latencyMs: [450, 550] };

const BUSINESS_TYPES = [
  { id: 'software-saas', label: 'Software/SaaS Company' },
  { id: 'iso-wholesale', label: 'ISO - Wholesale' },
  { id: 'iso-retail', label: 'ISO - Retail' },
  { id: 'unattended', label: 'Unattended/Manufacturer/Kiosk' },
  { id: 'bank', label: 'Bank' },
  { id: 'merchant', label: 'Merchant/Retailer' },
  { id: 'none', label: 'None of the above' },
];

const PRODUCT_INTERESTS = [
  { id: 'payment-gateway', label: 'Payment gateway' },
  { id: 'nmi-payments', label: 'NMI Payments' },
  { id: 'merchant-management', label: 'Merchant Management' },
  { id: 'unattended-vending', label: 'Unattended/Vending' },
  { id: 'money-movement', label: 'Money Movement' },
  { id: 'fee-navigator', label: 'Fee Navigator' },
];

const PREFILL = {
  firstName: 'Jordan',
  lastName: 'Ellis',
  company: 'Brightline Booking',
  email: 'jordan.ellis@brightlinebooking.com',
  phone: '(415) 555-0142',
  businessType: 'software-saas',
  productInterest: 'payment-gateway',
  message: 'We run scheduling software for 3,200 salons and spas and want to embed white-label payments with our existing processor relationships.',
};

const PROCESSOR_PLATFORMS = [
  { name: 'TSYS Sierra', certified: true },
  { name: 'Fiserv Nashville', certified: true },
  { name: 'Fiserv Omaha', certified: true },
  { name: 'Elavon', certified: true },
  { name: 'Worldpay Core', certified: true },
  { name: 'Global Payments East', certified: true },
  { name: 'Chase Paymentech', certified: true },
  { name: 'Heartland', certified: true },
  { name: 'Paysafe', certified: false },
  { name: 'Moneris', certified: true },
  { name: 'Priority', certified: true },
  { name: 'Maverick', certified: false },
  { name: 'Payroc', certified: true },
  { name: 'Paya', certified: true },
];

const ISV_PARTNERSHIPS_TEAM = {
  name: 'Morgan Hale',
  title: 'Partner Solutions Consultant, ISV & SaaS',
  email: 'mhale@nmi.example',
  team: 'ISV Partnerships',
};

const SPECIALIST_TEAMS = {
  'iso-wholesale': {
    name: 'Dana Brooks',
    title: 'ISO Wholesale Relationship Manager',
    email: 'dbrooks@nmi.example',
    team: 'ISO Wholesale Partnerships',
  },
  'iso-retail': {
    name: 'Riley Chen',
    title: 'ISO Retail Partnership Manager',
    email: 'rchen@nmi.example',
    team: 'ISO Retail Partnerships',
  },
  unattended: {
    name: 'Alex Morgan',
    title: 'Unattended Solutions Consultant',
    email: 'amorgan@nmi.example',
    team: 'Unattended Solutions',
  },
  bank: {
    name: 'Taylor Reed',
    title: 'Financial Institution Solutions Director',
    email: 'treed@nmi.example',
    team: 'Financial Institution Partnerships',
  },
  merchant: {
    name: 'Casey Rivera',
    title: 'Merchant Solutions Consultant',
    email: 'crivera@nmi.example',
    team: 'Merchant Solutions',
  },
  none: {
    name: 'Jamie Ellis',
    title: 'Business Development Representative',
    email: 'jellis@nmi.example',
    team: 'Business Development',
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the NMI Talk to Our Team contact request:',
  '- Service: `app/services/verticals/7c3e9a52.js`',
  '- Route: `app/routes/verticals/7c3e9a52.js`',
  '- Page: `app/public/verticals/7c3e9a52.html` (served at `/nmi` and `/nmi/talk-to-our-team`)',
  '- Test: `tests/7c3e9a52-contact-request.test.js`',
  '',
  'Default Software/SaaS requests succeed but take ~7s, breaching the 3000ms latency budget and triggering a Devin session.',
  'Find the root cause in `assessProcessorCoverage` and `checkProcessorCertification`. Preserve the latency budget, breach alert, simulated per-call latency, response shape, and processor-coverage order.',
  'Fix the sequential processor-certification checks with `Promise.all` while preserving result order.',
  'Run `npx jest tests/7c3e9a52-contact-request.test.js --runInBand` and `npm run lint`.',
  'Verify the default request returns in under 3 seconds.',
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

function validateContactRequest(data, requestId) {
  if (!data.firstName || !data.lastName || !data.company) {
    throw createValidationError(
      'Enter your first name, last name and company name.',
      'CONTACT_DETAILS_REQUIRED',
      requestId,
    );
  }

  if (typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    throw createValidationError('Enter a valid email address.', 'INVALID_EMAIL', requestId);
  }

  if (data.phone && data.phone.replace(/\D/g, '').length < 10) {
    throw createValidationError('Enter a valid phone number.', 'INVALID_PHONE', requestId);
  }

  if (!BUSINESS_TYPES.some(({ id }) => id === data.businessType)) {
    throw createValidationError('Select your business type.', 'INVALID_BUSINESS_TYPE', requestId);
  }

  if (!PRODUCT_INTERESTS.some(({ id }) => id === data.productInterest)) {
    throw createValidationError('Select a product interest.', 'INVALID_PRODUCT_INTEREST', requestId);
  }
}

async function checkProcessorCertification(platform) {
  const [min, max] = PROCESSOR_CHECK_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  return platform.certified;
}

async function assessProcessorCoverage(businessType) {
  if (businessType !== 'software-saas') {
    const specialist = SPECIALIST_TEAMS[businessType];
    const [min, max] = PROCESSOR_CHECK_POLICY.latencyMs;
    await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
    return {
      team: specialist,
      coverage: [],
      processorsChecked: 1,
    };
  }

  const coverage = [];
  for (const platform of PROCESSOR_PLATFORMS) {
    coverage.push({
      processor: platform.name,
      certified: await checkProcessorCertification(platform),
    });
  }

  return {
    team: ISV_PARTNERSHIPS_TEAM,
    coverage,
    processorsChecked: PROCESSOR_PLATFORMS.length,
  };
}

async function routeContactRequest(contactRequest) {
  return assessProcessorCoverage(contactRequest.businessType);
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, processorsChecked, data,
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
      processorsChecked,
    },
  });

  if (!claimLatencyAlert('7c3e9a52')) {
    logger.info('NMI Talk to Our Team latency breach alert suppressed by cooldown', { requestId, durationMs });
    return;
  }

  Promise.resolve(createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/7c3e9a52.js — assessProcessorCoverage',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'NMI Talk to Our Team',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '7c3e9a52',
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
      processorsChecked,
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
  })).then((result) => {
    if (!result) releaseLatencyAlert('7c3e9a52');
  }).catch((alertError) => {
    releaseLatencyAlert('7c3e9a52');
    logger.error('Failed to create Devin session for NMI contact request latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function submitContactRequest(data = {}) {
  const startTime = Date.now();
  const requestId = `NMI-TTT-${uuidv4().slice(0, 6).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    firstName: String(requestData.firstName || '').trim(),
    lastName: String(requestData.lastName || '').trim(),
    company: String(requestData.company || '').trim(),
    email: String(requestData.email || '').trim(),
    phone: String(requestData.phone || '').trim(),
    businessType: requestData.businessType === undefined ? 'software-saas' : requestData.businessType,
    productInterest: requestData.productInterest === undefined ? 'payment-gateway' : requestData.productInterest,
  };

  validateContactRequest(normalized, requestId);

  logger.info('Routing NMI Talk to Our Team contact request', {
    requestId,
    businessType: normalized.businessType,
    productInterest: normalized.productInterest,
    service: SERVICE,
    route: ROUTE,
  });

  const routing = await routeContactRequest(normalized);
  const durationMs = Date.now() - startTime;

  incrementMetric('contact_request.success', {
    route: ROUTE,
    businessType: normalized.businessType,
  });
  recordTiming('contact_request.latency', durationMs, { route: ROUTE });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('contact_request.latency_budget_breach', {
      route: ROUTE,
      businessType: normalized.businessType,
    });
    logger.warn('NMI contact request exceeded latency budget — triggering Devin', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      processorsChecked: routing.processorsChecked,
      businessType: normalized.businessType,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      processorsChecked: routing.processorsChecked,
      data: normalized,
    }));
  }

  const businessType = BUSINESS_TYPES.find(({ id }) => id === normalized.businessType);
  const productInterest = PRODUCT_INTERESTS.find(({ id }) => id === normalized.productInterest);
  const certifiedProcessors = routing.coverage.filter(({ certified }) => certified).length;

  return {
    success: true,
    requestId,
    request: {
      id: requestId,
      status: 'submitted',
      businessType: normalized.businessType,
      businessTypeLabel: businessType.label,
      productInterest: normalized.productInterest,
      productInterestLabel: productInterest.label,
      contact: {
        name: `${normalized.firstName} ${normalized.lastName}`,
        email: normalized.email,
        company: normalized.company,
        phone: normalized.phone,
      },
      routedTo: {
        team: routing.team.team,
        name: routing.team.name,
        title: routing.team.title,
        email: routing.team.email,
      },
      processorCoverage: routing.coverage,
      certifiedProcessors,
      nextStep: `Thanks, ${normalized.firstName}! ${routing.team.name} from our ${routing.team.team} team will reach out within 1 business day.`,
    },
    timing: {
      totalMs: durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      processorsChecked: routing.processorsChecked,
    },
  };
}

module.exports = {
  submitContactRequest,
  checkProcessorCertification,
  assessProcessorCoverage,
  routeContactRequest,
  SERVICE,
  ROUTE,
  LATENCY_SLO,
  PROCESSOR_CHECK_POLICY,
  BUSINESS_TYPES,
  PRODUCT_INTERESTS,
  PREFILL,
  PROCESSOR_PLATFORMS,
  SPECIALIST_TEAMS,
  ISV_PARTNERSHIPS_TEAM,
  REMEDIATION_DIRECTIVE,
};
