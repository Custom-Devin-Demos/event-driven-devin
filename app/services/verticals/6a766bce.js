const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Portfolio-filter taxonomies. Each facet carries the terms used to filter the
 * active-projects table by status, market, region and phase.
 *
 * NOTE: The map keys are intentionally pluralized (statuses/markets/regions/
 * phases) while the frontend sends singular filterType values (status/market/
 * region/phase). This mismatch is the root cause of the deterministic
 * TypeError on every filter interaction — the selected taxonomy object is
 * undefined, so `.terms` throws.
 */
const TAXONOMY_MAP = {
  statuses: {
    terms: [
      { slug: 'on-track', label: 'On Track' },
      { slug: 'at-risk', label: 'At Risk' },
      { slug: 'delayed', label: 'Delayed' },
      { slug: 'complete', label: 'Complete' },
    ],
  },
  markets: {
    terms: [
      { slug: 'transportation', label: 'Transportation' },
      { slug: 'water', label: 'Water' },
      { slug: 'energy', label: 'Energy' },
      { slug: 'buildings-places', label: 'Buildings & Places' },
      { slug: 'environment', label: 'Environment' },
    ],
  },
  regions: {
    terms: [
      { slug: 'americas', label: 'Americas' },
      { slug: 'emea', label: 'EMEA' },
      { slug: 'apac', label: 'APAC' },
    ],
  },
  phases: {
    terms: [
      { slug: 'planning', label: 'Planning' },
      { slug: 'design', label: 'Design' },
      { slug: 'construction', label: 'Construction' },
      { slug: 'closeout', label: 'Closeout' },
    ],
  },
};

/**
 * Mock active-project portfolio. Each row carries the facets the frontend can
 * filter by plus the columns rendered in the dashboard table.
 */
const PROJECTS = [
  { id: 'PRJ-4821', name: 'Heathrow Terminal 2 Expansion', client: 'Heathrow Airport Ltd', status: 'on-track', market: 'transportation', region: 'emea', phase: 'construction', budget: 48200000, complete: 62 },
  { id: 'PRJ-4822', name: 'York Region Transit Corridor', client: 'York Region', status: 'at-risk', market: 'transportation', region: 'americas', phase: 'design', budget: 21500000, complete: 38 },
  { id: 'PRJ-4823', name: 'Sydney Coastal Resilience Program', client: 'City of Sydney', status: 'on-track', market: 'environment', region: 'apac', phase: 'planning', budget: 9800000, complete: 15 },
  { id: 'PRJ-4824', name: 'Manchester Metrolink Extension', client: 'Transport for Greater Manchester', status: 'delayed', market: 'transportation', region: 'emea', phase: 'construction', budget: 33100000, complete: 54 },
  { id: 'PRJ-4825', name: 'IU Health Medical Center Campus', client: 'Indiana University Health', status: 'on-track', market: 'buildings-places', region: 'americas', phase: 'design', budget: 27400000, complete: 41 },
  { id: 'PRJ-4826', name: 'New River Bridge Replacement', client: 'State DOT', status: 'complete', market: 'transportation', region: 'americas', phase: 'closeout', budget: 15600000, complete: 100 },
  { id: 'PRJ-4827', name: 'West Link Rail Tunnel MEP', client: 'Trafikverket', status: 'at-risk', market: 'transportation', region: 'emea', phase: 'construction', budget: 41900000, complete: 48 },
  { id: 'PRJ-4828', name: 'NZ Climate Risk Assessment', client: 'Ministry for the Environment', status: 'on-track', market: 'environment', region: 'apac', phase: 'planning', budget: 6200000, complete: 22 },
];

/**
 * Build the filtered portfolio view for the selected taxonomy term.
 */
function buildPortfolioView(data) {
  // The frontend sends filterType values like 'status', 'market', 'region' and
  // 'phase' (singular). The map is keyed with plural names, so `selected` is
  // always undefined here and the next line throws the intentional TypeError.
  const selected = TAXONOMY_MAP[data.filterType];
  const term = selected.terms.find((t) => t.slug === data.value);

  const matches = data.value === 'all'
    ? PROJECTS
    : PROJECTS.filter((p) => p[data.filterType] === data.value);

  return {
    filterType: data.filterType,
    value: data.value,
    termLabel: term ? term.label : 'All',
    count: matches.length,
    projects: matches,
  };
}

/**
 * Handle a portfolio filter request.
 */
async function filterPortfolio(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Filtering AECOM project portfolio', {
    requestId,
    filterType: data.filterType,
    value: data.value,
    service: 'customer-6a766bce-portfolio',
    route: '/api/6a766bce/filter',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 90));

    const view = buildPortfolioView(data);

    const duration = Date.now() - startTime;
    incrementMetric('portfolio.filter.success', {
      route: '/api/6a766bce/filter',
      filterType: data.filterType,
    });
    recordTiming('portfolio.filter.latency', duration, { route: '/api/6a766bce/filter' });

    return { ...view, requestId, filteredAt: new Date().toISOString() };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('portfolio.filter.failure', {
      route: '/api/6a766bce/filter',
      errorClass: error.name,
    });
    recordTiming('portfolio.filter.latency', duration, { route: '/api/6a766bce/filter', error: 'true' });

    logger.error('AECOM project portfolio filter failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      filterType: data.filterType,
      service: 'customer-6a766bce-portfolio',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/6a766bce/filter',
        service: 'customer-6a766bce-portfolio',
        filterType: data.filterType,
      },
      extra: { requestId, filterType: data.filterType, value: data.value },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/6a766bce.js — buildPortfolioView',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-6a766bce-portfolio',
      verticalLabel: 'Project Portfolio Filter',
      customer: '6a766bce',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/6a766bce/filter' },
        { key: 'service', value: 'customer-6a766bce-portfolio' },
        { key: 'filterType', value: data.filterType },
      ],
      extra: { requestId, filterType: data.filterType, value: data.value },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-6a766bce-portfolio@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for portfolio error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { filterPortfolio, PROJECTS, TAXONOMY_MAP };
