const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Procurement resource library taxonomies. Each facet carries the terms used to
 * filter the downloadable resources by industry, solution and content type.
 *
 * NOTE: The map keys are intentionally pluralized (industries/solutions/categories)
 * while the frontend sends singular filterType values (industry/solution/category).
 * This mismatch is the root cause of the deterministic TypeError on every filter
 * interaction — the selected taxonomy object is undefined, so `.terms` throws.
 */
const TAXONOMY_MAP = {
  industries: {
    terms: [
      { slug: 'automotive', label: 'Automotive', count: 4 },
      { slug: 'banking-insurance-financial-services', label: 'Banking, Insurance and Financial Services', count: 6 },
      { slug: 'construction', label: 'Construction', count: 2 },
      { slug: 'cpg', label: 'CPG', count: 5 },
      { slug: 'energy-utilities', label: 'Energy and Utilities', count: 3 },
      { slug: 'healthcare', label: 'Healthcare', count: 4 },
      { slug: 'higher-education', label: 'Higher Education', count: 2 },
      { slug: 'manufacturing', label: 'Manufacturing', count: 7 },
      { slug: 'public-sector', label: 'Public Sector', count: 3 },
      { slug: 'retail', label: 'Retail', count: 4 },
      { slug: 'technology', label: 'Technology', count: 5 },
      { slug: 'transportation-logistics', label: 'Transportation and Logistics', count: 3 },
    ],
  },
  solutions: {
    terms: [
      { slug: 'advanced-sourcing-optimizer', label: 'Advanced Sourcing Optimizer (ASO)', count: 2 },
      { slug: 'analytics', label: 'Analytics', count: 6 },
      { slug: 'autonomous-procurement', label: 'Autonomous Procurement', count: 4 },
      { slug: 'category-management', label: 'Category Management', count: 3 },
      { slug: 'contract-management', label: 'Contracts', count: 3 },
      { slug: 'direct-procurement', label: 'Direct Procurement', count: 5 },
      { slug: 'eprocurement', label: 'eProcurement', count: 4 },
      { slug: 'esg', label: 'ESG Intelligence', count: 3 },
      { slug: 'invoicing', label: 'Invoicing', count: 3 },
      { slug: 'payments', label: 'Payments', count: 2 },
      { slug: 'sourcing', label: 'Sourcing', count: 4 },
      { slug: 'spend-analytics', label: 'Spend Analytics', count: 5 },
      { slug: 'supplier-intelligence', label: 'Supplier Intelligence', count: 4 },
      { slug: 'supplier-management', label: 'Supplier Management', count: 3 },
      { slug: 'supply-chain-collaboration', label: 'Supply Chain Collaboration', count: 4 },
    ],
  },
  categories: {
    terms: [
      { slug: 'analyst-report', label: 'Analyst Report', count: 8 },
      { slug: 'brochure', label: 'Brochure', count: 6 },
      { slug: 'checklist', label: 'Checklist', count: 3 },
      { slug: 'datasheet', label: 'Datasheet', count: 5 },
      { slug: 'ebook-guide', label: 'Guide and eBook', count: 7 },
      { slug: 'infographic', label: 'Infographic', count: 4 },
      { slug: 'product-brief', label: 'Product Brief', count: 3 },
      { slug: 'tool', label: 'Tool', count: 2 },
      { slug: 'webinar', label: 'Webinar On-Demand', count: 9 },
      { slug: 'whitepaper', label: 'White Paper', count: 10 },
    ],
  },
};

/**
 * Mock resource library. Each item has the facets the frontend can filter by.
 */
const RESOURCES = [
  { id: 'esg-impact-2025', title: 'JAGGAER ESG Impact Report 2025', type: 'whitepaper', industry: 'manufacturing', solution: 'esg' },
  { id: 'mfg-benchmark-2026', title: 'Manufacturing Supply Chain & Procurement Benchmark 2026', type: 'analyst-report', industry: 'manufacturing', solution: 'direct-procurement' },
  { id: 'autonomous-procurement-guide', title: 'The Practical Guide to Autonomous Procurement', type: 'ebook-guide', industry: 'cross-industry', solution: 'autonomous-procurement' },
  { id: 'supplier-intelligence-brief', title: 'Supplier Intelligence Product Brief', type: 'product-brief', industry: 'technology', solution: 'supplier-intelligence' },
  { id: 'cost-reduction-checklist', title: '10-Point Cost Reduction Checklist', type: 'checklist', industry: 'cpg', solution: 'spend-analytics' },
  { id: 'sourcing-optimization-webinar', title: 'Sourcing Optimization in Action', type: 'webinar', industry: 'energy-utilities', solution: 'advanced-sourcing-optimizer' },
];

/**
 * Build the filtered resource view for the selected taxonomy term.
 */
function buildResourceView(data) {
  // The frontend sends filterType values like 'industry', 'solution' and
  // 'dlm_download_category' (the name of the content-type select). The map
  // is keyed with plural names, so `selected` is always undefined here and
  // the next line throws the intentional TypeError.
  const selected = TAXONOMY_MAP[data.filterType];
  const term = selected.terms.find((t) => t.slug === data.value);

  const matches = RESOURCES.filter((r) => {
    if (data.filterType === 'industry') return r.industry === data.value;
    if (data.filterType === 'solution') return r.solution === data.value;
    return r.type === data.value;
  });

  return {
    filterType: data.filterType,
    termLabel: term.label,
    count: matches.length,
    resources: matches.map((r) => ({ id: r.id, title: r.title })),
  };
}

/**
 * Handle a resource-library filter request.
 */
async function filterResources(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Filtering procurement resource library', {
    requestId,
    filterType: data.filterType,
    value: data.value,
    service: 'customer-6c89c6b0-resources',
    route: '/api/6c89c6b0/filter',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 90));

    const view = buildResourceView(data);

    const duration = Date.now() - startTime;
    incrementMetric('resource_library.filter.success', {
      route: '/api/6c89c6b0/filter',
      filterType: data.filterType,
    });
    recordTiming('resource_library.filter.latency', duration, { route: '/api/6c89c6b0/filter' });

    return { ...view, requestId, filteredAt: new Date().toISOString() };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('resource_library.filter.failure', {
      route: '/api/6c89c6b0/filter',
      errorClass: error.name,
    });
    recordTiming('resource_library.filter.latency', duration, { route: '/api/6c89c6b0/filter', error: 'true' });

    logger.error('Procurement resource library filter failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      filterType: data.filterType,
      service: 'customer-6c89c6b0-resources',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/6c89c6b0/filter',
        service: 'customer-6c89c6b0-resources',
        filterType: data.filterType,
      },
      extra: { requestId, filterType: data.filterType, value: data.value },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/6c89c6b0.js — buildResourceView',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-6c89c6b0-resources',
      verticalLabel: 'Resource Library Filter',
      customer: '6c89c6b0',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/6c89c6b0/filter' },
        { key: 'service', value: 'customer-6c89c6b0-resources' },
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
      release: process.env.SENTRY_RELEASE || 'customer-6c89c6b0-resources@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for resource library error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { filterResources, RESOURCES, TAXONOMY_MAP };
