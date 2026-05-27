const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Levi's product catalog — denim SKUs across distribution centers
 */
const CATALOG = [
  { sku: 'LEV-501-OG32', name: "Levi's 501 Original Fit 32\"", line: '501 Original', category: 'mens-jeans', unitPrice: 69.50, caseQty: 24 },
  { sku: 'LEV-511-SL30', name: "Levi's 511 Slim Fit 30\"", line: '511 Slim', category: 'mens-jeans', unitPrice: 69.50, caseQty: 24 },
  { sku: 'LEV-512-TP32', name: "Levi's 512 Slim Taper 32\"", line: '512 Slim Taper', category: 'mens-jeans', unitPrice: 79.50, caseQty: 24 },
  { sku: 'LEV-505-RG34', name: "Levi's 505 Regular Fit 34\"", line: '505 Regular', category: 'mens-jeans', unitPrice: 59.50, caseQty: 24 },
  { sku: 'LEV-502-TP33', name: "Levi's 502 Taper 33\"", line: '502 Taper', category: 'mens-jeans', unitPrice: 69.50, caseQty: 24 },
  { sku: 'LEV-721-HR28', name: "Levi's 721 High Rise Skinny 28\"", line: '721 High Rise', category: 'womens-jeans', unitPrice: 69.50, caseQty: 24 },
  { sku: 'LEV-501-WC26', name: "Levi's 501 Original Cropped 26\"", line: '501 Crop', category: 'womens-jeans', unitPrice: 79.50, caseQty: 24 },
  { sku: 'LEV-TRK-JKM', name: "Levi's Trucker Jacket — Medium Wash", line: 'Trucker Jacket', category: 'outerwear', unitPrice: 89.50, caseQty: 12 },
  { sku: 'LEV-EX-BF30', name: "Levi's Ex-Boyfriend Trucker Jacket", line: 'Outerwear', category: 'outerwear', unitPrice: 98.00, caseQty: 12 },
];

/**
 * Distribution centers with inventory levels
 */
const DISTRIBUTION_CENTERS = [
  { id: 'DC-SFO', name: 'Levi\'s DC — San Francisco', location: 'San Francisco, CA', region: 'west', skus: 428, capacity: 82, fillRate: 97.4, stockouts: 0, status: 'optimal' },
  { id: 'DC-HEN', name: 'Levi\'s DC — Henderson', location: 'Henderson, NV', region: 'west', skus: 385, capacity: 91, fillRate: 94.8, stockouts: 2, status: 'low-stock' },
  { id: 'DC-DAL', name: 'Levi\'s DC — Dallas', location: 'Dallas, TX', region: 'south', skus: 372, capacity: 76, fillRate: 96.1, stockouts: 1, status: 'optimal' },
  { id: 'DC-ATL', name: 'Levi\'s DC — Atlanta', location: 'Atlanta, GA', region: 'south', skus: 341, capacity: 88, fillRate: 93.2, stockouts: 4, status: 'stockout' },
  { id: 'DC-CHI', name: 'Levi\'s DC — Chicago', location: 'Chicago, IL', region: 'midwest', skus: 396, capacity: 69, fillRate: 98.5, stockouts: 0, status: 'optimal' },
  { id: 'DC-EWR', name: 'Levi\'s DC — Newark', location: 'Newark, NJ', region: 'northeast', skus: 410, capacity: 95, fillRate: 95.9, stockouts: 1, status: 'overstock' },
];

/**
 * Queries inventory status for a given region and returns DC-level summaries.
 */
function queryInventory(region) {
  const dcs = region
    ? DISTRIBUTION_CENTERS.filter((dc) => dc.region === region.toLowerCase())
    : DISTRIBUTION_CENTERS;

  return dcs.map((dc) => ({
    dcId: dc.id,
    name: dc.name,
    fillRate: dc.fillRate,
    stockouts: dc.stockouts,
    status: dc.status,
  }));
}

/**
 * Aggregates region-level metrics from the distribution center results.
 */
function aggregateRegionMetrics(dcResults) {
  const totalFillRate = dcResults.reduce((s, r) => s + r.fillRate, 0) / dcResults.length;
  const totalStockouts = dcResults.reduce((s, r) => s + r.stockouts, 0);
  return { metrics: { fillRate: Math.round(totalFillRate * 10) / 10, stockouts: totalStockouts, dcCount: dcResults.length } };
}

/**
 * Formats the final query response using the aggregated region summary.
 */
function formatQuerySummary(aggregated) {
  return {
    avgFillRate: aggregated.summary.fillRate,
    totalStockouts: aggregated.summary.stockouts,
    totalDCs: aggregated.summary.dcCount,
  };
}

/**
 * Process a supply chain query (simulates NL query against inventory systems).
 */
async function processQuery(queryData) {
  const startTime = Date.now();
  const queryId = uuidv4();

  logger.info('Processing supply chain query', {
    queryId,
    query: queryData.query,
    region: queryData.region,
    service: 'levis-supply-chain',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const results = queryInventory(queryData.region);
    const aggregated = aggregateRegionMetrics(results);
    const summary = formatQuerySummary(aggregated);

    const duration = Date.now() - startTime;

    incrementMetric('query.success', {
      route: '/api/levis/query',
      region: queryData.region || 'all',
    });
    recordTiming('query.latency', duration, {
      route: '/api/levis/query',
    });

    return {
      success: true,
      queryId,
      query: queryData.query,
      results,
      totalDCs: summary.totalDCs,
      avgFillRate: summary.avgFillRate,
      totalStockouts: summary.totalStockouts,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('query.failure', {
      route: '/api/levis/query',
      errorClass: error.name,
    });
    recordTiming('query.latency', duration, {
      route: '/api/levis/query',
      error: 'true',
    });

    logger.error('Supply chain query failed', {
      queryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/levis/query',
        service: 'levis-supply-chain',
        region: queryData.region || 'all',
      },
      extra: { queryId, query: queryData.query },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/levis.js \u2014 queryInventory',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: queryData.devinUserId,
      devinEmail: queryData.devinEmail,
      devinOrgId: queryData.devinOrgId,
      service: 'levis-supply-chain',
      verticalLabel: 'Supply Chain Query',
      tags: [
        { key: 'route', value: '/api/levis/query' },
        { key: 'service', value: 'levis-supply-chain' },
      ],
      extra: { queryId, query: queryData.query },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'levis-supply-chain@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from supply chain query error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processQuery, queryInventory, CATALOG, DISTRIBUTION_CENTERS };
