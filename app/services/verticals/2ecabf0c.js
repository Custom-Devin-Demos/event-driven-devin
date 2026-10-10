/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-2ecabf0c-specialist-match';
const ROUTE = '/api/2ecabf0c/specialist-match';
const SLACK_MEMBER_ID = process.env.VGM_SLACK_MEMBER_ID || '';

const LATENCY_SLO = { budgetMs: 3000 };
const AVAILABILITY_LOOKUP_POLICY = { latencyMs: [450, 550] };

const COMPANIES = [
  { key: 'vgm_associates', label: 'VGM & Associates', serviceLine: 'Member services & HME advocacy' },
  { key: 'vgm_insurance', label: 'VGM Insurance', serviceLine: 'Business insurance & risk management' },
  { key: 'vgm_forbin', label: 'VGM Forbin', serviceLine: 'Web design, IT & cybersecurity' },
  { key: 'two_rivers', label: 'Two Rivers Marketing', serviceLine: 'B2B marketing & brand strategy' },
  { key: 'vgm_fulfillment', label: 'VGM Fulfillment', serviceLine: 'Product distribution & fulfillment' },
  { key: 'vgm_education', label: 'VGM Education', serviceLine: 'Accredited training & compliance courses' },
  { key: 'vgm_government_relations', label: 'VGM Government Relations', serviceLine: 'Policy & legislative advocacy' },
  { key: 'vgm_reimbursement', label: 'VGM Reimbursement Services', serviceLine: 'Billing, audits & payer appeals' },
  { key: 'vgm_payer_contracting', label: 'VGM Payer Contracting', serviceLine: 'Health plan contracting & networks' },
  { key: 'vgm_retail', label: 'VGM Retail Solutions', serviceLine: 'Retail merchandising & store design' },
  { key: 'vgm_patient_engagement', label: 'VGM Patient Engagement', serviceLine: 'Patient care coordination' },
  { key: 'vgm_accreditation', label: 'VGM Accreditation', serviceLine: 'Accreditation readiness & surveys' },
  { key: 'vgm_heartland', label: 'VGM Live at Heartland', serviceLine: 'Industry events & conferences' },
  { key: 'vgm_esop', label: 'VGM Employee Ownership', serviceLine: 'ESOP consulting & ownership transition' },
];

const ROUTING_OPTIONS = {
  all: { label: 'All VGM Group companies', companies: COMPANIES.map((company) => company.key) },
  vgm_associates: { label: 'VGM & Associates only', companies: ['vgm_associates'] },
  vgm_insurance: { label: 'VGM Insurance only', companies: ['vgm_insurance'] },
  vgm_forbin: { label: 'VGM Forbin only', companies: ['vgm_forbin'] },
};

const INDUSTRIES = {
  healthcare: { label: 'Healthcare (post-acute / HME)' },
  all_industry: { label: 'All industry' },
};

const SPECIALIST_FIRST_NAMES = ['Megan', 'Jordan', 'Alyssa', 'Tyler', 'Brooke', 'Nate', 'Kelsey', 'Marcus', 'Hannah', 'Derek', 'Lindsey', 'Cody'];
const SPECIALIST_LAST_NAMES = ['Hansen', 'Schmitt', 'Larsen', 'Becker', 'Olson', 'Meyer', 'Kruse', 'Nielsen', 'Wagner', 'Thompson', 'Miller', 'Peterson'];
const SPECIALIST_TITLES = ['Account Manager', 'Business Development Specialist', 'Client Success Lead', 'Solutions Consultant'];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the VGM Group specialist-match request:',
  '- Service: `app/services/verticals/2ecabf0c.js`',
  '- Route: `app/routes/verticals/2ecabf0c.js`',
  '- Page: `app/public/verticals/2ecabf0c.html` (served at `/vgm`)',
  '- Test: `tests/2ecabf0c-specialist-match.test.js`',
  '',
  'Specialist-match requests routed to the default "All VGM Group companies" option succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency in `collectSpecialistAvailability` and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-company availability lookup latency.',
  'Preserve the response payload for every routing option, including the company order in `matches` (VGM Group company directory order).',
  'Run `npx jest tests/2ecabf0c-specialist-match.test.js --runInBand` and `npm run lint`.',
  'Verify the default request at `/vgm` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function hashValue(value) {
  let hash = 2166136261;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

const CONSULT_TIME_ZONE = 'America/Chicago';

function zonedParts(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CONSULT_TIME_ZONE,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
  }).formatToParts(date);
  const value = (type) => Number(parts.find((part) => part.type === type).value);
  return {
    year: value('year'), month: value('month'), day: value('day'), hour: value('hour'), minute: value('minute'),
  };
}

function consultTimeToUtc(year, month, day, hour, minute) {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const local = zonedParts(new Date(guess));
  const offsetMs = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute) - guess;
  return new Date(guess - offsetMs);
}

function nextConsultSlot(from, offsetDays, hour, minute) {
  const today = zonedParts(from);
  const date = new Date(Date.UTC(today.year, today.month - 1, today.day));
  let remaining = offsetDays;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const day = date.getUTCDay();
    if (day !== 0 && day !== 6) remaining -= 1;
  }
  return consultTimeToUtc(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate(), hour, minute);
}

async function lookupCompanyAvailability(companyKey, request) {
  const [min, max] = AVAILABILITY_LOOKUP_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const company = COMPANIES.find((entry) => entry.key === companyKey);
  const seed = hashValue(`${request.businessName.toLowerCase()}:${request.industry}:${companyKey}`);
  const slotDate = nextConsultSlot(new Date(), 1 + (seed % 5), 8 + (seed % 9), (seed % 2) * 30);

  return {
    companyKey,
    company: company.label,
    serviceLine: company.serviceLine,
    specialist: `${SPECIALIST_FIRST_NAMES[seed % SPECIALIST_FIRST_NAMES.length]} ${SPECIALIST_LAST_NAMES[(seed >>> 4) % SPECIALIST_LAST_NAMES.length]}`,
    title: SPECIALIST_TITLES[(seed >>> 8) % SPECIALIST_TITLES.length],
    nextAvailable: slotDate.toISOString(),
  };
}

/**
 * Look up specialist availability for each routed company, in VGM Group directory order.
 */
async function collectSpecialistAvailability(companyKeys, request) {
  const matches = [];
  for (const companyKey of companyKeys) matches.push(await lookupCompanyAvailability(companyKey, request));
  return matches;
}

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function normalizeRequest(data) {
  const requestData = data && typeof data === 'object' ? data : {};
  const normalized = {
    businessName: String(requestData.businessName === undefined ? '' : requestData.businessName).trim(),
    email: String(requestData.email === undefined ? '' : requestData.email).trim().toLowerCase(),
    industry: String(requestData.industry === undefined ? 'healthcare' : requestData.industry).trim().toLowerCase(),
    routing: String(requestData.routing === undefined ? 'all' : requestData.routing).trim().toLowerCase(),
  };

  if (normalized.businessName.length < 2 || normalized.businessName.length > 120) {
    throw validationError('Enter your business name (2–120 characters).', 'BUSINESS_NAME_INVALID');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) {
    throw validationError('Enter a valid email address.', 'EMAIL_INVALID');
  }
  if (!Object.hasOwn(INDUSTRIES, normalized.industry) || !Object.hasOwn(ROUTING_OPTIONS, normalized.routing)) {
    throw validationError('Choose a valid industry and routing option.', 'ROUTING_INVALID');
  }

  return normalized;
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, companiesQueried, data,
  } = context;
  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      routing: data.routing,
      industry: data.industry,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      companiesQueried,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/2ecabf0c.js — collectSpecialistAvailability',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'VGM Group Specialist Match',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '2ecabf0c',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'routing', value: data.routing },
      { key: 'industry', value: data.industry },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      companiesQueried,
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
    logger.error('Failed to create Devin session for VGM Group specialist-match latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function matchSpecialists(data = {}) {
  const startTime = Date.now();
  const requestId = `VGM-${uuidv4().slice(0, 8).toUpperCase()}`;
  let normalized;
  try {
    normalized = normalizeRequest(data);
  } catch (error) {
    error.requestId = requestId;
    throw error;
  }
  const routing = ROUTING_OPTIONS[normalized.routing];

  logger.info('Matching VGM Group specialists', {
    requestId,
    industry: normalized.industry,
    routing: normalized.routing,
    service: SERVICE,
    route: ROUTE,
  });

  const matches = await collectSpecialistAvailability(routing.companies, normalized);
  const durationMs = Date.now() - startTime;

  incrementMetric('specialist_match.success', {
    route: ROUTE,
    routing: normalized.routing,
    industry: normalized.industry,
  });
  recordTiming('specialist_match.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('specialist_match.latency_budget_breach', {
      route: ROUTE,
      routing: normalized.routing,
      industry: normalized.industry,
    });
    logger.warn('VGM Group specialist match exceeded latency budget — triggering Devin', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      companiesQueried: routing.companies.length,
      routing: normalized.routing,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      companiesQueried: routing.companies.length,
      data: {
        ...normalized,
        devinUserId: data.devinUserId,
        devinOrgId: data.devinOrgId,
        devinEmail: data.devinEmail,
      },
    }));
  }

  return {
    success: true,
    requestId,
    businessName: normalized.businessName,
    email: normalized.email,
    industry: { key: normalized.industry, label: INDUSTRIES[normalized.industry].label },
    routing: { key: normalized.routing, label: routing.label },
    companiesQueried: routing.companies.length,
    matches,
    durationMs,
  };
}

module.exports = {
  matchSpecialists,
  nextConsultSlot,
  COMPANIES,
  ROUTING_OPTIONS,
  INDUSTRIES,
  AVAILABILITY_LOOKUP_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
