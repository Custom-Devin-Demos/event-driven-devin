const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Project-library taxonomies. Each facet carries the terms used to filter the
 * project cards by market, service and location.
 *
 * NOTE: The map keys are intentionally pluralized (markets/services/locations)
 * while the frontend sends singular filterType values (market/service/location).
 * This mismatch is the root cause of the deterministic TypeError on every filter
 * interaction — the selected taxonomy object is undefined, so `.terms` throws.
 */
const TAXONOMY_MAP = {
  markets: {
    terms: [
      { slug: 'transportation', label: 'Transportation', count: 6 },
      { slug: 'water', label: 'Water', count: 4 },
      { slug: 'energy', label: 'Energy', count: 5 },
      { slug: 'buildings-places', label: 'Buildings & Places', count: 7 },
      { slug: 'environment', label: 'Environment', count: 3 },
      { slug: 'sports-and-venues', label: 'Sports and Venues', count: 2 },
    ],
  },
  services: {
    terms: [
      { slug: 'program-management', label: 'Program Management', count: 5 },
      { slug: 'engineering', label: 'Engineering', count: 8 },
      { slug: 'architecture-and-design', label: 'Architecture and Design', count: 4 },
      { slug: 'environmental-services', label: 'Environmental Services', count: 6 },
      { slug: 'cost-management', label: 'Cost Management', count: 3 },
      { slug: 'digital-infrastructure-services', label: 'Digital Infrastructure Services', count: 2 },
    ],
  },
  locations: {
    terms: [
      { slug: 'united-states', label: 'United States', count: 9 },
      { slug: 'united-kingdom', label: 'United Kingdom', count: 6 },
      { slug: 'australia', label: 'Australia', count: 4 },
      { slug: 'canada', label: 'Canada', count: 3 },
      { slug: 'hong-kong', label: 'Hong Kong', count: 3 },
      { slug: 'worldwide', label: 'Worldwide', count: 5 },
    ],
  },
};

/**
 * Mock project library. Each item carries the facets the frontend can filter by.
 */
const PROJECTS = [
  { id: 'mandalay-airport', title: 'Mandalay International Airport Land Use Feasibility Study', market: 'transportation', service: 'program-management', location: 'worldwide' },
  { id: 'pg-hangar', title: 'Procter & Gamble Hangar', market: 'buildings-places', service: 'architecture-and-design', location: 'united-states' },
  { id: 'strategic-rail-roads', title: 'Strategic Studies on Railways and Major Roads beyond 2030', market: 'transportation', service: 'program-management', location: 'hong-kong' },
  { id: 'heathrow-t2', title: 'Heathrow Airport – Future Terminal 2', market: 'transportation', service: 'engineering', location: 'united-kingdom' },
  { id: 'york-region', title: 'Connecting communities across York Region', market: 'transportation', service: 'engineering', location: 'canada' },
  { id: 'new-river-bridge', title: 'New River Bridge', market: 'transportation', service: 'engineering', location: 'united-states' },
];

/**
 * Build the filtered project view for the selected taxonomy term.
 */
function buildProjectView(data) {
  // The frontend sends filterType values like 'market', 'service' and
  // 'location' (singular). The map is keyed with plural names, so `selected`
  // is always undefined here and the next line throws the intentional TypeError.
  const selected = TAXONOMY_MAP[data.filterType];
  const term = selected.terms.find((t) => t.slug === data.value);

  const matches = PROJECTS.filter((p) => {
    if (data.filterType === 'market') return p.market === data.value;
    if (data.filterType === 'service') return p.service === data.value;
    return p.location === data.value;
  });

  return {
    filterType: data.filterType,
    termLabel: term.label,
    count: matches.length,
    projects: matches.map((p) => ({ id: p.id, title: p.title })),
  };
}

/**
 * Handle a project-library filter request.
 */
async function filterProjects(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Filtering AECOM project library', {
    requestId,
    filterType: data.filterType,
    value: data.value,
    service: 'customer-6a766bce-projects',
    route: '/api/6a766bce/filter',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 90));

    const view = buildProjectView(data);

    const duration = Date.now() - startTime;
    incrementMetric('project_library.filter.success', {
      route: '/api/6a766bce/filter',
      filterType: data.filterType,
    });
    recordTiming('project_library.filter.latency', duration, { route: '/api/6a766bce/filter' });

    return { ...view, requestId, filteredAt: new Date().toISOString() };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('project_library.filter.failure', {
      route: '/api/6a766bce/filter',
      errorClass: error.name,
    });
    recordTiming('project_library.filter.latency', duration, { route: '/api/6a766bce/filter', error: 'true' });

    logger.error('AECOM project library filter failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      filterType: data.filterType,
      service: 'customer-6a766bce-projects',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/6a766bce/filter',
        service: 'customer-6a766bce-projects',
        filterType: data.filterType,
      },
      extra: { requestId, filterType: data.filterType, value: data.value },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/6a766bce.js — buildProjectView',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-6a766bce-projects',
      verticalLabel: 'Project Library Filter',
      customer: '6a766bce',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/6a766bce/filter' },
        { key: 'service', value: 'customer-6a766bce-projects' },
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
      release: process.env.SENTRY_RELEASE || 'customer-6a766bce-projects@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for project library error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { filterProjects, PROJECTS, TAXONOMY_MAP };
