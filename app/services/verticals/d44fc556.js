/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  claimLatencyAlert,
  latencyAlertKey,
  releaseLatencyAlert,
  startedInvestigation,
} = require('../latency-alert-cooldown');

const SLACK_MEMBER_ID = process.env.WELLINGTON_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-d44fc556-contact-enquiry';
const ROUTE = '/api/d44fc556/enquiries';

const LATENCY_SLO = { budgetMs: 3000 };
const DESK_LOOKUP_POLICY = { latencyMs: [450, 550] };

const ENQUIRY_TYPES = [
  { id: 'product-invest', label: 'I want information on a product or I want to invest' },
  { id: 'job-opportunities', label: "I'm interested in job opportunities" },
  { id: 'report-scam', label: 'I want to report a scam' },
  { id: 'employment-verification', label: 'Employment verification' },
  { id: 'technical-issue', label: 'I have a technical issue' },
  { id: 'corporate-access', label: 'Corporate access enquiry - For companies to reach Wellington' },
];

const COUNTRIES = [
  'United States',
  'United Kingdom',
  'Canada',
  'Australia',
  'Germany',
  'France',
  'Ireland',
  'Luxembourg',
  'Switzerland',
  'Netherlands',
  'Italy',
  'Spain',
  'Japan',
  'Hong Kong',
  'China',
  'Singapore',
  'Other',
];

const PREFILL = {
  enquiryType: 'product-invest',
  email: 'priya.raman@harborstatepension.org',
  firstName: 'Priya',
  lastName: 'Raman',
  company: 'Harbor State Teachers Pension Fund',
  country: 'United States',
};

const RELATIONSHIP_DESKS = [
  {
    name: 'North America Institutional — Boston',
    office: 'Boston',
    countries: ['United States'],
    team: { name: 'Elizabeth Carver', title: 'Relationship Manager, Public Pensions', email: 'ecarver@wellington.example' },
  },
  {
    name: 'Intermediary Distribution — Radnor',
    office: 'Radnor',
    countries: [],
    team: { name: 'Daniel Okafor', title: 'Intermediary Relationship Manager', email: 'dokafor@wellington.example' },
  },
  {
    name: 'Corporate & Endowments — Chicago',
    office: 'Chicago',
    countries: [],
    team: { name: 'Hannah Moreau', title: 'Relationship Manager, Endowments & Foundations', email: 'hmoreau@wellington.example' },
  },
  {
    name: 'West Coast Institutional — San Francisco',
    office: 'San Francisco',
    countries: [],
    team: { name: 'Marcus Lee', title: 'Relationship Manager, Institutional', email: 'mlee@wellington.example' },
  },
  {
    name: 'Canada Institutional — Toronto',
    office: 'Toronto',
    countries: ['Canada'],
    team: { name: 'Sophie Tremblay', title: 'Relationship Manager, Canada', email: 'stremblay@wellington.example' },
  },
  {
    name: 'UK Institutional — London',
    office: 'London',
    countries: ['United Kingdom'],
    team: { name: 'Oliver Hastings', title: 'Relationship Manager, UK Pensions', email: 'ohastings@wellington.example' },
  },
  {
    name: 'Ireland & Fund Platform — Dublin',
    office: 'Dublin',
    countries: ['Ireland'],
    team: { name: 'Aoife Brennan', title: 'Relationship Manager, Ireland', email: 'abrennan@wellington.example' },
  },
  {
    name: 'DACH Institutional — Frankfurt',
    office: 'Frankfurt',
    countries: ['Germany', 'Netherlands'],
    team: { name: 'Lukas Weber', title: 'Relationship Manager, DACH', email: 'lweber@wellington.example' },
  },
  {
    name: 'European Funds — Luxembourg',
    office: 'Luxembourg',
    countries: ['Luxembourg', 'France', 'Italy', 'Spain'],
    team: { name: 'Camille Laurent', title: 'Relationship Manager, Continental Europe', email: 'claurent@wellington.example' },
  },
  {
    name: 'Swiss Institutional — Zurich',
    office: 'Zurich',
    countries: ['Switzerland'],
    team: { name: 'Nina Keller', title: 'Relationship Manager, Switzerland', email: 'nkeller@wellington.example' },
  },
  {
    name: 'Greater China — Hong Kong',
    office: 'Hong Kong',
    countries: ['Hong Kong', 'China'],
    team: { name: 'Kevin Chan', title: 'Relationship Manager, Greater China', email: 'kchan@wellington.example' },
  },
  {
    name: 'Southeast Asia — Singapore',
    office: 'Singapore',
    countries: ['Singapore'],
    team: { name: 'Mei Lin Tan', title: 'Relationship Manager, Southeast Asia', email: 'mltan@wellington.example' },
  },
  {
    name: 'Japan Institutional — Tokyo',
    office: 'Tokyo',
    countries: ['Japan'],
    team: { name: 'Kenji Watanabe', title: 'Relationship Manager, Japan', email: 'kwatanabe@wellington.example' },
  },
  {
    name: 'Australia & New Zealand — Sydney',
    office: 'Sydney',
    countries: ['Australia'],
    team: { name: 'Grace Whitlam', title: 'Relationship Manager, Australia', email: 'gwhitlam@wellington.example' },
  },
];

const FALLBACK_DESK = 'Intermediary Distribution — Radnor';

const SPECIALIST_TEAMS = {
  'job-opportunities': {
    office: 'Boston',
    team: { name: 'Global Talent Acquisition', title: 'Careers team', email: 'careers@wellington.example' },
  },
  'report-scam': {
    office: 'Boston',
    team: { name: 'Fraud & Information Security', title: 'Security operations', email: 'security@wellington.example' },
  },
  'employment-verification': {
    office: 'Boston',
    team: { name: 'HR Shared Services', title: 'Employment verification', email: 'hr-verification@wellington.example' },
  },
  'technical-issue': {
    office: 'Boston',
    team: { name: 'Client Portal Support', title: 'Digital client services', email: 'portal-support@wellington.example' },
  },
  'corporate-access': {
    office: 'London',
    team: { name: 'Global Industry Research', title: 'Corporate access team', email: 'corporate-access@wellington.example' },
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Wellington Management contact-us enquiry:',
  '- Service: `app/services/verticals/d44fc556.js`',
  '- Route: `app/routes/verticals/d44fc556.js`',
  '- Page: `app/public/verticals/d44fc556.html` (served at `/wellington`)',
  '- Test: `tests/d44fc556-contact-enquiry.test.js`',
  '',
  'Default "product information / invest" enquiries succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause in `matchRelationshipDesks` and `lookupRelationshipDesk`. Preserve the latency budget, breach alert, simulated per-call latency, response shape, and order of relationship-desk results.',
  'Fix the sequential relationship-desk lookups with `Promise.all` while preserving result order.',
  'Run `npx jest tests/d44fc556-contact-enquiry.test.js --runInBand` and `npm run lint`.',
  'Verify the default enquiry returns in under 3 seconds.',
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

function validateEnquiry(data, requestId) {
  if (!ENQUIRY_TYPES.some(({ id }) => id === data.enquiryType)) {
    throw createValidationError('Select how we can help you.', 'INVALID_ENQUIRY_TYPE', requestId);
  }

  if (typeof data.email !== 'string' || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email)) {
    throw createValidationError('Enter a valid email address.', 'INVALID_EMAIL', requestId);
  }

  if (!data.firstName || !data.lastName || !data.company) {
    throw createValidationError(
      'Enter your first name, last name and company name.',
      'CONTACT_DETAILS_REQUIRED',
      requestId,
    );
  }

  if (!data.country) {
    throw createValidationError('Select your country.', 'COUNTRY_REQUIRED', requestId);
  }
}

async function lookupRelationshipDesk(desk, country) {
  const [min, max] = DESK_LOOKUP_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  return {
    desk: desk.name,
    office: desk.office,
    covers: desk.countries.includes(country),
    team: desk.team,
  };
}

async function matchRelationshipDesks(country) {
  const results = [];
  for (const desk of RELATIONSHIP_DESKS) {
    results.push(await lookupRelationshipDesk(desk, country));
  }

  const match = results.find((result) => result.covers)
    || results.find((result) => result.desk === FALLBACK_DESK);

  return {
    office: match.office,
    desk: match.desk,
    team: match.team,
    desksChecked: results.length,
  };
}

async function routeEnquiry(enquiry) {
  if (enquiry.enquiryType === 'product-invest') {
    return matchRelationshipDesks(enquiry.country);
  }

  const specialist = SPECIALIST_TEAMS[enquiry.enquiryType];
  const [min, max] = DESK_LOOKUP_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
  return {
    office: specialist.office,
    desk: specialist.team.name,
    team: specialist.team,
    desksChecked: 1,
  };
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, desksChecked, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      enquiryType: data.enquiryType,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      desksChecked,
    },
  });

  const alertKey = latencyAlertKey('d44fc556', data.devinOrgId);
  const claim = claimLatencyAlert(alertKey);
  if (!claim) {
    logger.info('Wellington Management latency breach alert suppressed by cooldown', { requestId, durationMs });
    return;
  }

  Promise.resolve(createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/d44fc556.js — matchRelationshipDesks',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Wellington Management Contact Enquiry',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'd44fc556',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'enquiry_type', value: data.enquiryType },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      desksChecked,
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
    if (!startedInvestigation(result)) releaseLatencyAlert(alertKey, claim);
  }).catch((alertError) => {
    releaseLatencyAlert(alertKey, claim);
    logger.error('Failed to create Devin session for Wellington enquiry latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function submitEnquiry(data = {}) {
  const startTime = Date.now();
  const requestId = `WMC-ENQ-${uuidv4().slice(0, 6).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    email: String(requestData.email || '').trim(),
    firstName: String(requestData.firstName || '').trim(),
    lastName: String(requestData.lastName || '').trim(),
    company: String(requestData.company || '').trim(),
    country: String(requestData.country || '').trim(),
    enquiryType: requestData.enquiryType === undefined ? 'product-invest' : requestData.enquiryType,
  };

  validateEnquiry(normalized, requestId);

  logger.info('Routing Wellington contact-us enquiry', {
    requestId,
    enquiryType: normalized.enquiryType,
    country: normalized.country,
    service: SERVICE,
    route: ROUTE,
  });

  const routing = await routeEnquiry(normalized);
  const durationMs = Date.now() - startTime;

  incrementMetric('enquiry.success', {
    route: ROUTE,
    enquiryType: normalized.enquiryType,
  });
  recordTiming('enquiry.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('enquiry.latency_budget_breach', {
      route: ROUTE,
      enquiryType: normalized.enquiryType,
    });
    logger.warn('Wellington enquiry exceeded latency budget — triggering Devin', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      desksChecked: routing.desksChecked,
      enquiryType: normalized.enquiryType,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      desksChecked: routing.desksChecked,
      data: normalized,
    }));
  }

  const enquiryType = ENQUIRY_TYPES.find(({ id }) => id === normalized.enquiryType);

  return {
    success: true,
    requestId,
    enquiry: {
      id: requestId,
      status: 'submitted',
      enquiryType: normalized.enquiryType,
      enquiryLabel: enquiryType.label,
      contact: {
        name: `${normalized.firstName} ${normalized.lastName}`,
        email: normalized.email,
        company: normalized.company,
        country: normalized.country,
      },
      routedTo: {
        office: routing.office,
        desk: routing.desk,
        name: routing.team.name,
        title: routing.team.title,
        email: routing.team.email,
      },
      nextStep: `Your request has been submitted. A member of our ${routing.office} team will respond within 2 business days.`,
    },
    timing: {
      totalMs: durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      desksChecked: routing.desksChecked,
    },
  };
}

module.exports = {
  submitEnquiry,
  lookupRelationshipDesk,
  matchRelationshipDesks,
  routeEnquiry,
  ENQUIRY_TYPES,
  COUNTRIES,
  PREFILL,
  RELATIONSHIP_DESKS,
  SPECIALIST_TEAMS,
  DESK_LOOKUP_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
