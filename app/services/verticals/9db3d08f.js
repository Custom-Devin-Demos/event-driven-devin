const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Claims workspace filter facets. Each facet carries the options the adjuster
 * desktop can filter the claims list by.
 *
 * NOTE: The map keys are intentionally pluralized (lobs/lossCauses/adjusters/
 * statuses) while the frontend sends singular filterType values (lob/lossCause/
 * adjuster/status). This mismatch is the root cause of the deterministic
 * TypeError on every filter interaction — the selected facet object is
 * undefined, so `.options` throws.
 */
const FILTER_FACETS = {
  lobs: {
    options: [
      { slug: 'personal-auto', label: 'Personal Auto', count: 46 },
      { slug: 'homeowners', label: 'Homeowners', count: 31 },
      { slug: 'commercial-property', label: 'Commercial Property', count: 22 },
      { slug: 'general-liability', label: 'General Liability', count: 17 },
      { slug: 'workers-comp', label: "Workers' Compensation", count: 12 },
    ],
  },
  lossCauses: {
    options: [
      { slug: 'collision', label: 'Collision', count: 28 },
      { slug: 'hail', label: 'Hail', count: 14 },
      { slug: 'water-damage', label: 'Water Damage', count: 19 },
      { slug: 'fire', label: 'Fire', count: 9 },
      { slug: 'theft', label: 'Theft', count: 11 },
      { slug: 'wind', label: 'Wind', count: 16 },
    ],
  },
  adjusters: {
    options: [
      { slug: 's-alvarez', label: 'Sofia Alvarez', count: 34 },
      { slug: 'm-chen', label: 'Marcus Chen', count: 33 },
      { slug: 'p-okafor', label: 'Priya Okafor', count: 31 },
      { slug: 'd-whitfield', label: 'Dana Whitfield', count: 30 },
    ],
  },
  statuses: {
    options: [
      { slug: 'all', label: 'All Open', count: 128 },
      { slug: 'new', label: 'New', count: 17 },
      { slug: 'in-litigation', label: 'In Litigation', count: 6 },
      { slug: 'reopened', label: 'Reopened', count: 3 },
      { slug: 'closed', label: 'Closed', count: 412 },
    ],
  },
};

/**
 * Mock claims workspace inventory. Each claim carries the facets the adjuster
 * desktop can filter by.
 */
const CLAIMS = [
  { id: '235-53-425891', insured: 'Ray Newton', lob: 'personal-auto', lossCause: 'collision', adjuster: 's-alvarez', status: 'all' },
  { id: '235-53-425904', insured: 'Hannah Ortiz', lob: 'homeowners', lossCause: 'water-damage', adjuster: 'm-chen', status: 'new' },
  { id: '235-53-425917', insured: 'Kestrel Logistics LLC', lob: 'commercial-property', lossCause: 'fire', adjuster: 'p-okafor', status: 'in-litigation' },
  { id: '235-53-425923', insured: 'Devon Marsh', lob: 'personal-auto', lossCause: 'hail', adjuster: 'd-whitfield', status: 'new' },
  { id: '235-53-425888', insured: 'Brightleaf Cafe Group', lob: 'general-liability', lossCause: 'slip-fall', adjuster: 's-alvarez', status: 'all' },
  { id: '235-53-425861', insured: 'Talia Broussard', lob: 'homeowners', lossCause: 'wind', adjuster: 'm-chen', status: 'all' },
  { id: '235-53-425712', insured: 'Northgate Fabrication', lob: 'workers-comp', lossCause: 'machinery-injury', adjuster: 'p-okafor', status: 'closed' },
  { id: '235-53-425934', insured: 'Imani Fletcher', lob: 'personal-auto', lossCause: 'theft', adjuster: 'd-whitfield', status: 'new' },
];

/**
 * Build the filtered claims view for the selected facet value.
 */
function buildClaimsView(data) {
  // The frontend sends filterType values like 'lob', 'lossCause', 'adjuster'
  // and 'status'. The map is keyed with plural names, so `selected` is always
  // undefined here and the next line throws the intentional TypeError.
  const selected = FILTER_FACETS[data.filterType];
  const term = selected.options.find((o) => o.slug === data.value);

  const matches = CLAIMS.filter((c) => {
    if (data.filterType === 'lob') return c.lob === data.value;
    if (data.filterType === 'lossCause') return c.lossCause === data.value;
    if (data.filterType === 'adjuster') return c.adjuster === data.value;
    return c.status === data.value;
  });

  return {
    filterType: data.filterType,
    termLabel: term ? term.label : 'All claims',
    count: matches.length,
    claims: matches.map((c) => ({ id: c.id, insured: c.insured })),
  };
}

/**
 * Handle a claims workspace filter request.
 */
async function filterClaims(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Filtering claims workspace', {
    requestId,
    filterType: data.filterType,
    value: data.value,
    service: 'customer-9db3d08f-claims',
    route: '/api/9db3d08f/filter',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 90));

    const view = buildClaimsView(data);

    const duration = Date.now() - startTime;
    incrementMetric('claims_workspace.filter.success', {
      route: '/api/9db3d08f/filter',
      filterType: data.filterType,
    });
    recordTiming('claims_workspace.filter.latency', duration, { route: '/api/9db3d08f/filter' });

    return { ...view, requestId, filteredAt: new Date().toISOString() };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('claims_workspace.filter.failure', {
      route: '/api/9db3d08f/filter',
      errorClass: error.name,
    });
    recordTiming('claims_workspace.filter.latency', duration, { route: '/api/9db3d08f/filter', error: 'true' });

    logger.error('Claims workspace filter failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      filterType: data.filterType,
      service: 'customer-9db3d08f-claims',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/9db3d08f/filter',
        service: 'customer-9db3d08f-claims',
        filterType: data.filterType,
      },
      extra: { requestId, filterType: data.filterType, value: data.value },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/9db3d08f.js — buildClaimsView',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-9db3d08f-claims',
      verticalLabel: 'Claims Workspace Filter',
      customer: '9db3d08f',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/9db3d08f/filter' },
        { key: 'service', value: 'customer-9db3d08f-claims' },
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
      release: process.env.SENTRY_RELEASE || 'customer-9db3d08f-claims@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for claims workspace error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { filterClaims, CLAIMS, FILTER_FACETS };
