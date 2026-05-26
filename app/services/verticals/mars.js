const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Mars product catalog — confectionery SKUs across distribution centers
 */
const CATALOG = [
  { sku: 'SKU-MM-P174', name: "M&M's Peanut 1.74oz", brand: "M&M's", category: 'chocolate', unitPrice: 2.19, caseQty: 48 },
  { sku: 'SKU-MM-M177', name: "M&M's Milk Choc 1.69oz", brand: "M&M's", category: 'chocolate', unitPrice: 2.19, caseQty: 48 },
  { sku: 'SKU-SN-O186', name: 'Snickers Original 1.86oz', brand: 'Snickers', category: 'chocolate', unitPrice: 2.29, caseQty: 48 },
  { sku: 'SKU-TW-O186', name: 'Twix Original 1.79oz', brand: 'Twix', category: 'chocolate', unitPrice: 2.09, caseQty: 36 },
  { sku: 'SKU-MW-O211', name: 'Milky Way Original 2.05oz', brand: 'Milky Way', category: 'chocolate', unitPrice: 1.99, caseQty: 36 },
  { sku: 'SKU-SK-O217', name: 'Skittles Original 2.17oz', brand: 'Skittles', category: 'candy', unitPrice: 2.09, caseQty: 36 },
  { sku: 'SKU-SB-O207', name: 'Starburst Original 2.07oz', brand: 'Starburst', category: 'candy', unitPrice: 1.89, caseQty: 36 },
  { sku: 'SKU-3M-O213', name: '3 Musketeers 2.13oz', brand: '3 Musketeers', category: 'chocolate', unitPrice: 1.79, caseQty: 36 },
  { sku: 'SKU-DV-M100', name: 'Dove Milk Chocolate Bar 1.44oz', brand: 'Dove', category: 'premium', unitPrice: 2.49, caseQty: 24 },
];

/**
 * Distribution centers with inventory levels
 */
const DISTRIBUTION_CENTERS = [
  { id: 'DC-CHI', name: 'Mars DC — Chicago', location: 'Chicago, IL', region: 'midwest', skus: 312, capacity: 87, fillRate: 98.2, stockouts: 0, status: 'optimal' },
  { id: 'DC-DAL', name: 'Mars DC — Dallas', location: 'Dallas, TX', region: 'south', skus: 287, capacity: 92, fillRate: 94.1, stockouts: 3, status: 'stockout' },
  { id: 'DC-ATL', name: 'Mars DC — Atlanta', location: 'Atlanta, GA', region: 'south', skus: 298, capacity: 78, fillRate: 95.6, stockouts: 2, status: 'low-stock' },
  { id: 'DC-EWR', name: 'Mars DC — Newark', location: 'Newark, NJ', region: 'northeast', skus: 305, capacity: 71, fillRate: 97.8, stockouts: 1, status: 'optimal' },
  { id: 'DC-PHX', name: 'Mars DC — Phoenix', location: 'Phoenix, AZ', region: 'west', skus: 245, capacity: 65, fillRate: 99.1, stockouts: 0, status: 'optimal' },
  { id: 'DC-SEA', name: 'Mars DC — Seattle', location: 'Seattle, WA', region: 'west', skus: 198, capacity: 94, fillRate: 96.3, stockouts: 1, status: 'overstock' },
];

/**
 * Queries inventory status for a given region and returns SKUs below safety stock.
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
 * Process a supply chain query (simulates NL query against legacy systems).
 */
async function processQuery(queryData) {
  const startTime = Date.now();
  const queryId = uuidv4();

  logger.info('Processing supply chain query', {
    queryId,
    query: queryData.query,
    region: queryData.region,
    service: 'mars-supply-chain',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const results = queryInventory(queryData.region);
    const aggregated = aggregateRegionMetrics(results);
    const summary = formatQuerySummary(aggregated);

    const duration = Date.now() - startTime;

    incrementMetric('query.success', {
      route: '/api/mars/query',
      region: queryData.region || 'all',
    });
    recordTiming('query.latency', duration, {
      route: '/api/mars/query',
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
      route: '/api/mars/query',
      errorClass: error.name,
    });
    recordTiming('query.latency', duration, {
      route: '/api/mars/query',
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
        route: '/api/mars/query',
        service: 'mars-supply-chain',
        region: queryData.region || 'all',
      },
      extra: { queryId, query: queryData.query },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/mars.js — queryInventory',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: queryData.devinUserId,
      devinEmail: queryData.devinEmail,
      devinOrgId: queryData.devinOrgId,
      service: 'mars-supply-chain',
      verticalLabel: 'Supply Chain Query',
      tags: [
        { key: 'route', value: '/api/mars/query' },
        { key: 'service', value: 'mars-supply-chain' },
      ],
      extra: { queryId, query: queryData.query },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'mars-supply-chain@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from supply chain query error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processQuery, queryInventory, CATALOG, DISTRIBUTION_CENTERS };
