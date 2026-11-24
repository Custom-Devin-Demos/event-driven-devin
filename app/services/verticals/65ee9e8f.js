/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { claimLatencyAlert, releaseLatencyAlert } = require('../latency-alert-cooldown');

const SLACK_MEMBER_ID = process.env.HARVEY_SLACK_MEMBER_ID || '';

const SERVICE = 'customer-65ee9e8f-demo-request';
const ROUTE = '/api/65ee9e8f/demo-requests';

const LATENCY_SLO = { budgetMs: 3000 };
const TERRITORY_LOOKUP_POLICY = { latencyMs: [450, 550] };

const ORGANIZATION_TYPES = [
  { id: 'law-firm', label: 'Law Firm' },
  { id: 'in-house', label: 'In-House Legal' },
  { id: 'professional-services', label: 'Professional Services' },
  { id: 'government', label: 'Government' },
  { id: 'other', label: 'Other' },
];

const COMPANY_SIZES = ['1-50', '51-200', '201-1,000', '1,001-5,000', '5,000+'];
const COUNTRIES = [
  'United States',
  'United Kingdom',
  'Canada',
  'Germany',
  'France',
  'Australia',
  'Singapore',
  'Japan',
  'India',
  'Other',
];

const PREFILL = {
  firstName: 'Morgan',
  lastName: 'Ellis',
  email: 'morgan.ellis@whitfieldcrane.com',
  company: 'Whitfield & Crane LLP',
  jobTitle: 'Partner, Head of Knowledge & Innovation',
  country: 'United States',
  phone: '+1 (212) 555-0148',
  organizationType: 'law-firm',
  companySize: '1,001-5,000',
  message: "We're evaluating generative AI for diligence and contract review across our M&A practice and would like a demo for our innovation committee.",
};

const TERRITORY_BOOKS = [
  {
    name: 'AmLaw 100 – Northeast',
    territory: 'Northeast',
    firms: ['Whitfield & Crane LLP'],
    organizationTypes: ['in-house'],
    accountOwner: { name: 'Jordan Blake', email: 'jordan.blake@harvey.ai' },
  },
  {
    name: 'AmLaw 100 – West',
    territory: 'West',
    firms: [],
    organizationTypes: ['professional-services'],
    accountOwner: { name: 'Riley Chen', email: 'riley.chen@harvey.ai' },
  },
  {
    name: 'AmLaw 200 – Midwest',
    territory: 'Midwest',
    firms: [],
    organizationTypes: ['government'],
    accountOwner: { name: 'Morgan Patel', email: 'morgan.patel@harvey.ai' },
  },
  {
    name: 'AmLaw 200 – South',
    territory: 'South',
    firms: [],
    organizationTypes: [],
    accountOwner: { name: 'Cameron Davis', email: 'cameron.davis@harvey.ai' },
  },
  {
    name: 'Global 200 – London',
    territory: 'United Kingdom',
    firms: [],
    organizationTypes: [],
    accountOwner: { name: 'Alex Morgan', email: 'alex.morgan@harvey.ai' },
  },
  {
    name: 'Global 200 – Continental Europe',
    territory: 'Continental Europe',
    firms: [],
    organizationTypes: [],
    accountOwner: { name: 'Taylor Fischer', email: 'taylor.fischer@harvey.ai' },
  },
  {
    name: 'APAC – Singapore',
    territory: 'Singapore',
    firms: [],
    organizationTypes: [],
    accountOwner: { name: 'Jamie Tan', email: 'jamie.tan@harvey.ai' },
  },
  {
    name: 'APAC – Sydney',
    territory: 'Australia',
    firms: [],
    organizationTypes: [],
    accountOwner: { name: 'Casey Wright', email: 'casey.wright@harvey.ai' },
  },
  {
    name: 'APAC – Tokyo',
    territory: 'Japan',
    firms: [],
    organizationTypes: [],
    accountOwner: { name: 'Sam Nakamura', email: 'sam.nakamura@harvey.ai' },
  },
  {
    name: 'Canada',
    territory: 'Canada',
    firms: [],
    organizationTypes: [],
    accountOwner: { name: 'Avery Singh', email: 'avery.singh@harvey.ai' },
  },
  {
    name: 'Middle East',
    territory: 'Middle East',
    firms: [],
    organizationTypes: [],
    accountOwner: { name: 'Drew Haddad', email: 'drew.haddad@harvey.ai' },
  },
  {
    name: 'LatAm',
    territory: 'Latin America',
    firms: [],
    organizationTypes: [],
    accountOwner: { name: 'Robin Silva', email: 'robin.silva@harvey.ai' },
  },
  {
    name: 'Mid-Market Law Firms',
    territory: 'Mid-Market',
    firms: [],
    organizationTypes: ['other'],
    accountOwner: { name: 'Quinn Foster', email: 'quinn.foster@harvey.ai' },
  },
  {
    name: 'Boutique & Specialty',
    territory: 'Boutique & Specialty',
    firms: [],
    organizationTypes: [],
    accountOwner: { name: 'Emerson Reed', email: 'emerson.reed@harvey.ai' },
  },
];

const NON_FIRM_BOOKS = {
  'in-house': 'AmLaw 100 – Northeast',
  'professional-services': 'AmLaw 100 – West',
  government: 'AmLaw 200 – Midwest',
  other: 'Mid-Market Law Firms',
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Harvey contact-sales demo request:',
  '- Service: `app/services/verticals/65ee9e8f.js`',
  '- Route: `app/routes/verticals/65ee9e8f.js`',
  '- Page: `app/public/verticals/65ee9e8f.html` (served at `/harvey`)',
  '- Test: `tests/65ee9e8f-demo-request.test.js`',
  '',
  'Default law-firm requests succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause in `matchFirmAcrossTerritories` and `lookupTerritoryBook`. Preserve the latency budget, breach alert, simulated per-call latency, response shape, and order of territory-book results.',
  'Fix the sequential territory-book lookups with `Promise.all` while preserving result order.',
  'Run `npx jest tests/65ee9e8f-demo-request.test.js --runInBand` and `npm run lint`.',
  'Verify the default demo request returns in under 3 seconds.',
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
  if (!data.firstName || !data.lastName || !data.company) {
    throw createValidationError(
      'Enter your first name, last name and company.',
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

  if (!ORGANIZATION_TYPES.some(({ id }) => id === data.organizationType)) {
    throw createValidationError(
      'Select a valid organization type.',
      'INVALID_ORGANIZATION_TYPE',
      requestId,
    );
  }
}

async function lookupTerritoryBook(book, firm, organizationType) {
  const [min, max] = TERRITORY_LOOKUP_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const firmMatches = book.firms.includes(firm);
  const organizationMatches = organizationType && book.organizationTypes.includes(organizationType);
  if (!firmMatches && !organizationMatches) return null;

  return {
    accountOwner: book.accountOwner,
    territory: book.territory,
  };
}

async function matchFirmAcrossTerritories(firm) {
  let match = null;
  for (const book of TERRITORY_BOOKS) {
    const result = await lookupTerritoryBook(book, firm);
    if (result && !match) match = result;
  }

  if (!match) {
    const fallbackBook = TERRITORY_BOOKS.find((book) => book.name === 'Mid-Market Law Firms');
    match = {
      accountOwner: fallbackBook.accountOwner,
      territory: fallbackBook.territory,
    };
  }

  return {
    ...match,
    territoryBooksChecked: TERRITORY_BOOKS.length,
  };
}

async function routeToAccountOwner(request) {
  if (request.organizationType === 'law-firm') {
    return matchFirmAcrossTerritories(request.company);
  }

  const bookName = NON_FIRM_BOOKS[request.organizationType];
  const book = TERRITORY_BOOKS.find((entry) => entry.name === bookName);
  const result = await lookupTerritoryBook(book, request.company, request.organizationType);
  return {
    ...result,
    territoryBooksChecked: 1,
  };
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, territoryBooksChecked, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      organizationType: data.organizationType,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      territoryBooksChecked,
    },
  });

  if (!claimLatencyAlert('65ee9e8f')) {
    logger.info('Harvey Contact Sales latency breach alert suppressed by cooldown', { requestId, durationMs });
    return;
  }

  Promise.resolve(createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/65ee9e8f.js — matchFirmAcrossTerritories',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Harvey Contact Sales Demo Request',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '65ee9e8f',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'organization_type', value: data.organizationType },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      territoryBooksChecked,
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
    if (!result) releaseLatencyAlert('65ee9e8f');
  }).catch((alertError) => {
    releaseLatencyAlert('65ee9e8f');
    logger.error('Failed to create Devin session for Harvey demo-request latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function submitDemoRequest(data = {}) {
  const startTime = Date.now();
  const requestId = `HRV-DR-${uuidv4().slice(0, 5).toUpperCase()}`;
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    ...requestData,
    firstName: String(requestData.firstName || '').trim(),
    lastName: String(requestData.lastName || '').trim(),
    email: String(requestData.email || '').trim(),
    company: String(requestData.company || '').trim(),
    organizationType: requestData.organizationType === undefined
      ? 'law-firm'
      : requestData.organizationType,
  };

  validateDemoRequest(normalized, requestId);

  logger.info('Routing Harvey contact-sales demo request', {
    requestId,
    organizationType: normalized.organizationType,
    service: SERVICE,
    route: ROUTE,
  });

  const routing = await routeToAccountOwner(normalized);
  const durationMs = Date.now() - startTime;

  incrementMetric('demo_request.success', {
    route: ROUTE,
    organizationType: normalized.organizationType,
  });
  recordTiming('demo_request.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('demo_request.latency_budget_breach', {
      route: ROUTE,
      organizationType: normalized.organizationType,
    });
    logger.warn('Harvey demo request exceeded latency budget', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      territoryBooksChecked: routing.territoryBooksChecked,
      organizationType: normalized.organizationType,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      territoryBooksChecked: routing.territoryBooksChecked,
      data: normalized,
    }));
  }

  return {
    success: true,
    requestId,
    demoRequest: {
      id: requestId,
      status: 'scheduled',
      contact: {
        name: `${normalized.firstName} ${normalized.lastName}`,
        email: normalized.email,
        company: normalized.company,
        jobTitle: normalized.jobTitle || '',
      },
      organizationType: normalized.organizationType,
      accountOwner: {
        name: routing.accountOwner.name,
        title: 'Enterprise Account Executive',
        email: routing.accountOwner.email,
        territory: routing.territory,
      },
      nextStep: 'Your Harvey account executive will reach out within 1 business day to schedule a live demo.',
    },
    timing: {
      totalMs: durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      territoryBooksChecked: routing.territoryBooksChecked,
    },
  };
}

module.exports = {
  submitDemoRequest,
  lookupTerritoryBook,
  matchFirmAcrossTerritories,
  routeToAccountOwner,
  ORGANIZATION_TYPES,
  COMPANY_SIZES,
  COUNTRIES,
  PREFILL,
  TERRITORY_BOOKS,
  TERRITORY_LOOKUP_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
