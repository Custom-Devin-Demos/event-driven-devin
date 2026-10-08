/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-485ddc93-obituary-search';
const ROUTE = '/api/485ddc93/obituary-search';
const SLACK_MEMBER_ID = process.env.TRIBUTETECH_SLACK_MEMBER_ID || '';

const LATENCY_SLO = { budgetMs: 3000 };
const ARCHIVE_INDEX_POLICY = { latencyMs: [450, 550] };

const REGIONS = [
  { key: 'new_england', label: 'New England', funeralHomes: 412, cities: [['Worcester', 'MA'], ['Hartford', 'CT'], ['Portland', 'ME']] },
  { key: 'mid_atlantic', label: 'Mid-Atlantic', funeralHomes: 968, cities: [['Allentown', 'PA'], ['Trenton', 'NJ'], ['Syracuse', 'NY']] },
  { key: 'southeast', label: 'Southeast', funeralHomes: 1124, cities: [['Charlotte', 'NC'], ['Greenville', 'SC'], ['Macon', 'GA']] },
  { key: 'florida', label: 'Florida', funeralHomes: 587, cities: [['Jacksonville', 'FL'], ['Ocala', 'FL'], ['Sarasota', 'FL']] },
  { key: 'great_lakes', label: 'Great Lakes', funeralHomes: 1043, cities: [['Toledo', 'OH'], ['Grand Rapids', 'MI'], ['Fort Wayne', 'IN']] },
  { key: 'upper_midwest', label: 'Upper Midwest', funeralHomes: 736, cities: [['Green Bay', 'WI'], ['Rochester', 'MN'], ['Cedar Rapids', 'IA']] },
  { key: 'great_plains', label: 'Great Plains', funeralHomes: 455, cities: [['Wichita', 'KS'], ['Lincoln', 'NE'], ['Sioux Falls', 'SD']] },
  { key: 'texas', label: 'Texas & South Central', funeralHomes: 1012, cities: [['Waco', 'TX'], ['Tyler', 'TX'], ['Tulsa', 'OK']] },
  { key: 'gulf_coast', label: 'Gulf Coast', funeralHomes: 618, cities: [['Lafayette', 'LA'], ['Mobile', 'AL'], ['Gulfport', 'MS']] },
  { key: 'mountain_west', label: 'Mountain West', funeralHomes: 389, cities: [['Boise', 'ID'], ['Billings', 'MT'], ['Fort Collins', 'CO']] },
  { key: 'southwest', label: 'Southwest', funeralHomes: 341, cities: [['Tucson', 'AZ'], ['Albuquerque', 'NM'], ['Henderson', 'NV']] },
  { key: 'pacific_northwest', label: 'Pacific Northwest', funeralHomes: 297, cities: [['Spokane', 'WA'], ['Salem', 'OR'], ['Tacoma', 'WA']] },
  { key: 'california', label: 'California & Hawaii', funeralHomes: 674, cities: [['Fresno', 'CA'], ['Riverside', 'CA'], ['Hilo', 'HI']] },
  { key: 'canada', label: 'Canada', funeralHomes: 503, cities: [['London', 'ON'], ['Red Deer', 'AB'], ['Moncton', 'NB']] },
];

const SEARCH_SCOPES = {
  all: { label: 'All Tribute Archive regions', regions: REGIONS.map((region) => region.key) },
  southeast: { label: 'Southeast only', regions: ['southeast'] },
  great_lakes: { label: 'Great Lakes only', regions: ['great_lakes'] },
  texas: { label: 'Texas & South Central only', regions: ['texas'] },
};

const DATE_RANGES = {
  last_30_days: { label: 'Last 30 days', days: 30 },
  last_12_months: { label: 'Last 12 months', days: 365 },
};

const FIRST_NAMES = ['Margaret', 'Robert', 'Dorothy', 'James', 'Evelyn', 'William', 'Shirley', 'Charles', 'Barbara', 'Richard', 'Joan', 'Donald', 'Patricia', 'George'];
const FUNERAL_HOME_FAMILIES = ['Whitaker', 'Brennan', 'Holloway', 'Castillo', 'Lindqvist', 'Abernathy', 'Okafor', 'Delacroix', 'Pruitt', 'Mancini', 'Harlow', 'Sutherland'];
const FUNERAL_HOME_PATTERNS = [
  (family) => `${family} Funeral Home`,
  (family) => `${family} & Sons Funeral Chapel`,
  (family, city) => `${city} Memorial Chapel`,
  (family, city) => `${family}-${city} Funeral & Cremation`,
];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the Tribute Archive obituary search request:',
  '- Service: `app/services/verticals/485ddc93.js`',
  '- Route: `app/routes/verticals/485ddc93.js`',
  '- Page: `app/public/verticals/485ddc93.html` (served at `/tributetech`)',
  '- Test: `tests/485ddc93-obituary-search.test.js`',
  '',
  'Obituary searches using the default "All Tribute Archive regions" scope succeed but take ~7s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency in `searchArchiveRegions` and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated per-region archive index latency.',
  'Preserve the response payload for every search scope, including the region order in `regions` (Tribute Archive region directory order).',
  'Run `npx jest tests/485ddc93-obituary-search.test.js --runInBand` and `npm run lint`.',
  'Verify the default search at `/tributetech` returns in under 3 seconds.',
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

function titleCase(value) {
  return value.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (match, sep, letter) => sep + letter.toUpperCase());
}

function utcDateDaysAgo(daysAgo, from = new Date()) {
  const date = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()));
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date;
}

function buildObituary(request, region, index) {
  const seed = hashValue(`${request.name.toLowerCase()}:${request.dateRange}:${region.key}:${index}`);
  const parts = request.name.split(/\s+/);
  const lastName = titleCase(parts[parts.length - 1]);
  const firstName = parts.length > 1 ? titleCase(parts.slice(0, -1).join(' ')) : FIRST_NAMES[seed % FIRST_NAMES.length];
  const [city, state] = region.cities[(seed >>> 3) % region.cities.length];
  const family = FUNERAL_HOME_FAMILIES[(seed >>> 6) % FUNERAL_HOME_FAMILIES.length];
  const funeralHome = FUNERAL_HOME_PATTERNS[(seed >>> 10) % FUNERAL_HOME_PATTERNS.length](family, city);

  const { days } = DATE_RANGES[request.dateRange];
  const passed = utcDateDaysAgo(1 + ((seed >>> 13) % (days - 1)));
  const passedYear = passed.getUTCFullYear();
  const age = 58 + ((seed >>> 17) % 41);
  const dateOfDeath = passed.toISOString().slice(0, 10);

  return {
    obituaryId: `TA-${passedYear}-${(seed >>> 4).toString(16).toUpperCase().padStart(7, '0').slice(-7)}`,
    name: `${firstName} ${lastName}`,
    birthYear: passedYear - age,
    dateOfDeath,
    age,
    funeralHome,
    city,
    state,
  };
}

async function queryRegionIndex(regionKey, request) {
  const [min, max] = ARCHIVE_INDEX_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));

  const region = REGIONS.find((entry) => entry.key === regionKey);
  const seed = hashValue(`${request.name.toLowerCase()}:${request.dateRange}:${regionKey}`);
  const count = 1 + (seed % 2);
  const obituaries = [];
  for (let i = 0; i < count; i += 1) obituaries.push(buildObituary(request, region, i));
  obituaries.sort((a, b) => b.dateOfDeath.localeCompare(a.dateOfDeath));

  return {
    regionKey,
    region: region.label,
    funeralHomesIndexed: region.funeralHomes,
    obituaries,
  };
}

/**
 * Query the Tribute Archive obituary index for each region in scope, in region directory order.
 */
async function searchArchiveRegions(regionKeys, request) {
  const regions = [];
  for (const regionKey of regionKeys) regions.push(await queryRegionIndex(regionKey, request));
  return regions;
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
    name: String(requestData.name === undefined ? '' : requestData.name).trim().replace(/\s+/g, ' '),
    dateRange: String(requestData.dateRange === undefined ? 'last_12_months' : requestData.dateRange).trim().toLowerCase(),
    scope: String(requestData.scope === undefined ? 'all' : requestData.scope).trim().toLowerCase(),
  };

  if (normalized.name.length < 2 || normalized.name.length > 80 || !/^[\p{L}][\p{L}' .-]*$/u.test(normalized.name)) {
    throw validationError('Enter a name to search (2–80 letters).', 'NAME_INVALID');
  }
  if (!Object.hasOwn(DATE_RANGES, normalized.dateRange) || !Object.hasOwn(SEARCH_SCOPES, normalized.scope)) {
    throw validationError('Choose a valid date range and search scope.', 'SCOPE_INVALID');
  }

  return normalized;
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, regionsQueried, data,
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
      date_range: data.dateRange,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      regionsQueried,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/485ddc93.js — searchArchiveRegions',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Tribute Technology Obituary Search',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '485ddc93',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'scope', value: data.scope },
      { key: 'date_range', value: data.dateRange },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      regionsQueried,
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
    logger.error('Failed to create Devin session for Tribute obituary-search latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function searchObituaries(data = {}) {
  const startTime = Date.now();
  const requestId = `TT-${uuidv4().slice(0, 8).toUpperCase()}`;
  let normalized;
  try {
    normalized = normalizeRequest(data);
  } catch (error) {
    error.requestId = requestId;
    throw error;
  }
  const scope = SEARCH_SCOPES[normalized.scope];

  logger.info('Searching Tribute Archive obituaries', {
    requestId,
    scope: normalized.scope,
    dateRange: normalized.dateRange,
    service: SERVICE,
    route: ROUTE,
  });

  const regions = await searchArchiveRegions(scope.regions, normalized);
  const durationMs = Date.now() - startTime;
  const totalResults = regions.reduce((sum, region) => sum + region.obituaries.length, 0);

  incrementMetric('obituary_search.success', {
    route: ROUTE,
    scope: normalized.scope,
    date_range: normalized.dateRange,
  });
  recordTiming('obituary_search.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('obituary_search.latency_budget_breach', {
      route: ROUTE,
      scope: normalized.scope,
      date_range: normalized.dateRange,
    });
    logger.warn('Tribute Archive obituary search exceeded latency budget — triggering Devin', {
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      regionsQueried: scope.regions.length,
      scope: normalized.scope,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      regionsQueried: scope.regions.length,
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
    query: normalized.name,
    dateRange: { key: normalized.dateRange, label: DATE_RANGES[normalized.dateRange].label },
    scope: { key: normalized.scope, label: scope.label },
    regionsQueried: scope.regions.length,
    funeralHomesSearched: regions.reduce((sum, region) => sum + region.funeralHomesIndexed, 0),
    totalResults,
    regions,
    durationMs,
  };
}

module.exports = {
  searchObituaries,
  REGIONS,
  SEARCH_SCOPES,
  DATE_RANGES,
  ARCHIVE_INDEX_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
