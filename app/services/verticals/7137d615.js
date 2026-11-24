/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const CUSTOMER = '7137d615';
const REPO = 'COG-GTM/event-driven-devin';
const SERVICE = 'customer-7137d615-octaura-contact';
const ROUTE = '/api/7137d615/contact-requests';
const SLACK_MEMBER_ID = process.env.OCTAURA_SLACK_MEMBER_ID || '';

const LATENCY_SLO = { budgetMs: 3000 };
const DESK_LOOKUP = { latencyMs: 500 };
const PRODUCTS = [
  { id: 'loan-trading', label: 'Loan trading' },
  { id: 'clo-trading', label: 'CLO trading' },
  { id: 'data-analytics', label: 'Data & analytics' },
];
const PREFILL = {
  firstName: 'Alex',
  lastName: 'Rivera',
  email: 'alex.rivera@northstar-credit.example',
  phone: '+1 (212) 555-0147',
  company: 'Northstar Credit Partners',
  message: 'We are evaluating electronic trading for syndicated loans and would like to see how Octaura supports our secondary-market workflow.',
  products: ['loan-trading'],
  consent: true,
};

const LOAN_DESKS = [
  'US Syndicated Loans',
  'European Syndicated Loans',
  'UK Syndicated Loans',
  'US Secondary Trading',
  'European Secondary Trading',
  'Distressed Credit',
  'Special Situations',
  'Loan Portfolio Trading',
  'Dealer Relationships',
  'Buy-Side Relationships',
  'Electronic Execution',
  'Market Lists',
  'Loan Data Services',
  'Loan Platform Onboarding',
];

const REMEDIATION_DIRECTIVE = [
  `*Repository to investigate and fix:* \`${REPO}\``,
  '',
  'The slow code path is Octaura Contact Us → Submit with Loan trading selected.',
  '- Service: `app/services/verticals/7137d615.js`',
  '- Route: `app/routes/verticals/7137d615.js`',
  '- Page: `app/public/verticals/7137d615.html`',
  '- Test: `tests/7137d615-contact-requests.test.js`',
  '',
  'Loan trading requests succeed but take ~7s against a 3000ms latency budget.',
  'Fix the sequential `lookupDesk` calls in `resolveContactDesk` with `Promise.all`. Preserve the budget, breach alert, simulated per-call delay, response shape and desk order.',
  'Run `npx jest tests/7137d615-contact-requests.test.js --runInBand` and verify the default request completes under 3 seconds.',
  'Open a fix pull request against `main`.',
].join('\n');

function validationError(code, message, requestId) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.requestId = requestId;
  return error;
}

function validateContactRequest(data, requestId) {
  const { email, company, products, consent } = data;
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) {
    throw validationError('INVALID_EMAIL', 'Enter a valid email address.', requestId);
  }
  if (typeof company !== 'string' || !company.trim() || company.length > 200) {
    throw validationError('INVALID_COMPANY', 'Enter your company name.', requestId);
  }
  if (!Array.isArray(products) || !products.length || products.length > PRODUCTS.length
    || new Set(products).size !== products.length
    || products.some((id) => !PRODUCTS.some((product) => product.id === id))) {
    throw validationError('INVALID_PRODUCTS', 'Select one or more products of interest.', requestId);
  }
  if (consent !== true) {
    throw validationError('CONSENT_REQUIRED', 'Acknowledge the privacy notice to submit.', requestId);
  }
}

async function lookupDesk(name) {
  await new Promise((resolve) => setTimeout(resolve, DESK_LOOKUP.latencyMs));
  return { name, available: name !== 'Distressed Credit' };
}

async function resolveContactDesk(products) {
  if (!products.includes('loan-trading')) {
    const desk = await lookupDesk(products.includes('clo-trading') ? 'CLO Trading' : 'Data & Analytics');
    return { routedTo: desk.name, desks: [desk] };
  }

  const desks = [];
  for (const name of LOAN_DESKS) {
    desks.push(await lookupDesk(name));
  }
  return { routedTo: desks.find(({ available }) => available).name, desks };
}

function reportLatencyBreach({ requestId, durationMs, budgetMs, desksChecked, presenter }) {
  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';
  const extra = { requestId, durationMs, budgetMs, desksChecked };

  Sentry.captureException(error, {
    level: 'warning',
    tags: { route: ROUTE, service: SERVICE, alert_path: 'latency' },
    extra,
  });

  createSessionAndAlert({
    ...presenter,
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/7137d615.js — resolveContactDesk',
    errorType: error.name,
    errorValue: error.message,
    service: SERVICE,
    verticalLabel: 'Octaura Contact Us',
    promptAppendix: REMEDIATION_DIRECTIVE,
    repos: [REPO],
    customer: CUSTOMER,
    skipVulnerablePr: true,
    slackMemberId: presenter.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra,
    level: 'warning',
    platform: 'node',
    lastSeen: new Date().toISOString(),
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
    environment: process.env.DD_ENV || 'prod',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for Octaura contact latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function submitContactRequest(data) {
  const start = Date.now();
  const requestId = `OCT-${uuidv4().slice(0, 8).toUpperCase()}`;
  validateContactRequest(data, requestId);

  const { products } = data;
  const routing = await resolveContactDesk(products);
  const durationMs = Date.now() - start;
  const { budgetMs } = LATENCY_SLO;
  const desksChecked = routing.desks.length;
  const tags = { route: ROUTE, service: SERVICE };

  incrementMetric('contact_request.success', tags);
  recordTiming('contact_request.latency', durationMs, tags);
  if (durationMs > budgetMs) {
    incrementMetric('contact_request.latency_budget_breach', tags);
    logger.warn('Octaura contact request exceeded latency budget — triggering Devin', {
      ...tags, requestId, durationMs, budgetMs, desksChecked,
    });
    const presenter = {};
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) {
      if (typeof data[key] === 'string') presenter[key] = data[key].trim();
    }
    setImmediate(() => reportLatencyBreach({ requestId, durationMs, budgetMs, desksChecked, presenter }));
  }

  return {
    success: true,
    requestId,
    request: { status: 'submitted', products, ...routing },
    timing: { totalMs: durationMs, budgetMs, desksChecked },
  };
}

module.exports = { submitContactRequest, PRODUCTS, PREFILL, LATENCY_SLO, DESK_LOOKUP, LOAN_DESKS };
