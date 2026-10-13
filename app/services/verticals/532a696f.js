/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-532a696f-expert-availability';
const ROUTE = '/api/532a696f/expert-availability';
const SLACK_MEMBER_ID = process.env.SWORD_SLACK_MEMBER_ID || '';

const LATENCY_SLO = { budgetMs: 3000 };
const CENTRE_LOOKUP_POLICY = { latencyMs: [440, 520] };

const DELIVERY_CENTRES = [
  { key: 'australia', region: 'Australia', city: 'Sydney', capacity: [0.5, 0.9] },
  { key: 'belgium', region: 'Belgium', city: 'Brussels', capacity: [0.7, 1.1] },
  { key: 'canada', region: 'Canada', city: 'Calgary', capacity: [0.4, 0.8] },
  { key: 'france', region: 'France', city: 'Lyon', capacity: [0.9, 1.4] },
  { key: 'greece', region: 'Greece', city: 'Athens', capacity: [1, 1.5] },
  { key: 'india', region: 'India', city: 'Chennai', capacity: [1.1, 1.6] },
  { key: 'lebanon_cyprus', region: 'Lebanon & Cyprus', city: 'Beirut', capacity: [0.6, 1] },
  { key: 'luxembourg', region: 'Luxembourg', city: 'Windhof', capacity: [0.8, 1.2] },
  { key: 'portugal', region: 'Portugal', city: 'Lisbon', capacity: [0.6, 1] },
  { key: 'saudi_arabia', region: 'Saudi Arabia', city: 'Riyadh', capacity: [0.4, 0.8] },
  { key: 'spain', region: 'Spain', city: 'Madrid', capacity: [0.7, 1.1] },
  { key: 'switzerland', region: 'Switzerland', city: 'Geneva', capacity: [0.9, 1.3] },
  { key: 'uae', region: 'UAE', city: 'Dubai', capacity: [0.5, 0.9] },
  { key: 'uk', region: 'UK', city: 'Aberdeen', capacity: [1, 1.5] },
  { key: 'usa', region: 'USA', city: 'Houston', capacity: [0.6, 1] },
];

const REGION_SCOPES = {
  all: { label: 'All regions', centres: DELIVERY_CENTRES.map((centre) => centre.key) },
  uk: { label: 'UK only', centres: ['uk'] },
  france: { label: 'France only', centres: ['france'] },
  switzerland: { label: 'Switzerland only', centres: ['switzerland'] },
  usa: { label: 'USA only', centres: ['usa'] },
};

const COMPETENCIES = [
  { key: 'digital_services', label: 'Digital Services', baseSpecialists: 24 },
  { key: 'data_ai', label: 'Data & AI', baseSpecialists: 18 },
  { key: 'digital_workplace', label: 'Digital Workplace', baseSpecialists: 20 },
  { key: 'platform_security', label: 'Platform & Security', baseSpecialists: 16 },
  { key: 'digital_transformation', label: 'Digital Transformation', baseSpecialists: 12 },
  { key: 'managed_services', label: 'Managed Services', baseSpecialists: 30 },
  { key: 'information_management', label: 'Information Management', baseSpecialists: 14 },
  { key: 'software', label: 'Software', baseSpecialists: 10 },
];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Sword Group "Talk to an expert" availability check:',
  '- Service: `app/services/verticals/532a696f.js`',
  '- Route: `app/routes/verticals/532a696f.js`',
  '- Page: `app/public/verticals/532a696f.html` (served at `/swordgroup`)',
  '- Test: `tests/532a696f-expert-availability.test.js`',
  '',
  'Expert availability checks using the default "All regions" scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency in `collectRegionalAvailability`. Do not raise or remove the latency budget, the breach alert, or the simulated per-centre lookup latency.',
  'Preserve the response payload for every region scope, including centre order in `centres` (delivery-centre directory order).',
  'Run `npx jest tests/532a696f-expert-availability.test.js` and `npm run lint`.',
  'Verify the default availability check at `/swordgroup` returns in under 3 seconds.',
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

function addBusinessDays(from, days) {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  let remaining = days;
  while (remaining > 0) {
    date.setUTCDate(date.getUTCDate() + 1);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6) remaining -= 1;
  }
  return date.toISOString().slice(0, 10);
}

async function checkCentreAvailability(centreKey, request, competency) {
  const [minLatency, maxLatency] = CENTRE_LOOKUP_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, minLatency + Math.random() * (maxLatency - minLatency)));

  const centre = DELIVERY_CENTRES.find((entry) => entry.key === centreKey);
  const seed = hashValue(`${request.competency}:${centreKey}`);
  const capacity = centre.capacity[0] + ((seed % 10001) / 10000) * (centre.capacity[1] - centre.capacity[0]);
  const specialistsAvailable = Math.max(1, Math.round(competency.baseSpecialists * capacity));
  const leadTimeBusinessDays = 3 + (hashValue(`${request.competency}:${centreKey}:lead`) % 16);

  return {
    centreKey,
    region: centre.region,
    city: centre.city,
    specialistsAvailable,
    leadTimeBusinessDays,
    earliestStart: addBusinessDays(new Date(), leadTimeBusinessDays),
    status: 'available',
  };
}

/**
 * Check specialist availability at each delivery centre in scope, in directory order.
 */
async function collectRegionalAvailability(centreKeys, request, competency) {
  const results = [];
  for (const key of centreKeys) results.push(await checkCentreAvailability(key, request, competency));
  return results;
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
    name: typeof requestData.name === 'string' ? requestData.name.trim() : '',
    company: typeof requestData.company === 'string' ? requestData.company.trim() : '',
    email: typeof requestData.email === 'string' ? requestData.email.trim().toLowerCase() : '',
    competency: String(requestData.competency === undefined ? 'digital_services' : requestData.competency).trim().toLowerCase(),
    regions: String(requestData.regions === undefined ? 'all' : requestData.regions).trim().toLowerCase(),
  };

  if (normalized.name.length < 2 || normalized.name.length > 80) {
    throw validationError('Enter your full name (2–80 characters).', 'NAME_INVALID');
  }
  if (normalized.company.length < 2 || normalized.company.length > 80) {
    throw validationError('Enter your company name (2–80 characters).', 'COMPANY_INVALID');
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized.email)) {
    throw validationError('Enter a valid business email address.', 'EMAIL_INVALID');
  }
  if (!COMPETENCIES.some((entry) => entry.key === normalized.competency)
    || !Object.hasOwn(REGION_SCOPES, normalized.regions)) {
    throw validationError('Choose a valid competency and region.', 'SELECTION_INVALID');
  }

  return normalized;
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, centresQueried, data,
  } = context;
  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      competency: data.competency,
      regions: data.regions,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      centresQueried,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/532a696f.js — collectRegionalAvailability',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Sword Group Expert Availability',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '532a696f',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'competency', value: data.competency },
      { key: 'regions', value: data.regions },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      centresQueried,
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
    logger.error('Failed to create Devin session for Sword Group expert-availability latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function checkExpertAvailability(data = {}) {
  const startTime = Date.now();
  const requestId = `SW-${uuidv4().slice(0, 8).toUpperCase()}`;
  let normalized;
  try {
    normalized = normalizeRequest(data);
  } catch (error) {
    error.requestId = requestId;
    throw error;
  }

  const competency = COMPETENCIES.find((entry) => entry.key === normalized.competency);
  const regionScope = REGION_SCOPES[normalized.regions];

  logger.info('Checking Sword Group expert availability', {
    requestId,
    competency: normalized.competency,
    regions: normalized.regions,
    service: SERVICE,
    route: ROUTE,
  });

  const centres = await collectRegionalAvailability(regionScope.centres, normalized, competency);
  const durationMs = Date.now() - startTime;
  const totalSpecialists = centres.reduce((sum, centre) => sum + centre.specialistsAvailable, 0);
  const fastest = centres.reduce((best, centre) => (
    centre.leadTimeBusinessDays < best.leadTimeBusinessDays ? centre : best
  ), centres[0]);

  incrementMetric('expert_availability.success', {
    route: ROUTE,
    competency: normalized.competency,
    regions: normalized.regions,
  });
  recordTiming('expert_availability.latency', durationMs, { route: ROUTE });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('expert_availability.latency_budget_breach', {
      route: ROUTE,
      competency: normalized.competency,
      regions: normalized.regions,
    });
    logger.warn('Sword Group expert availability check exceeded latency budget — triggering Devin', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      centresQueried: regionScope.centres.length,
      competency: normalized.competency,
      regions: normalized.regions,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      centresQueried: regionScope.centres.length,
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
    name: normalized.name,
    company: normalized.company,
    competency: { key: competency.key, label: competency.label },
    regions: { key: normalized.regions, label: regionScope.label },
    centresQueried: centres.length,
    totalSpecialists,
    fastestCentre: {
      centreKey: fastest.centreKey,
      region: fastest.region,
      city: fastest.city,
      earliestStart: fastest.earliestStart,
    },
    centres,
    durationMs,
  };
}

module.exports = {
  checkExpertAvailability,
  DELIVERY_CENTRES,
  REGION_SCOPES,
  COMPETENCIES,
  CENTRE_LOOKUP_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
