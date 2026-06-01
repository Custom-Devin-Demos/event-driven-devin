const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Best Buy product catalog — consumer electronics SKUs across distribution centers
 */
const CATALOG = [
  { sku: 'BBY-6565837', name: 'Samsung 65" Class S90D OLED 4K Smart TV', brand: 'Samsung', category: 'tv', unitPrice: 1599.99, caseQty: 4 },
  { sku: 'BBY-6571399', name: 'LG 55" Class C4 OLED evo 4K Smart TV', brand: 'LG', category: 'tv', unitPrice: 1399.99, caseQty: 4 },
  { sku: 'BBY-6535806', name: 'Apple MacBook Air 13.6" M3 (256GB)', brand: 'Apple', category: 'computing', unitPrice: 1099.99, caseQty: 10 },
  { sku: 'BBY-6571387', name: 'Dell XPS 13 Laptop (16GB / 512GB)', brand: 'Dell', category: 'computing', unitPrice: 1299.99, caseQty: 10 },
  { sku: 'BBY-6566621', name: 'Sony PlayStation 5 Slim Console', brand: 'Sony', category: 'gaming', unitPrice: 499.99, caseQty: 8 },
  { sku: 'BBY-6560251', name: 'Microsoft Xbox Series X 1TB Console', brand: 'Microsoft', category: 'gaming', unitPrice: 499.99, caseQty: 8 },
  { sku: 'BBY-6509650', name: 'Sony WH-1000XM5 Wireless Headphones', brand: 'Sony', category: 'audio', unitPrice: 399.99, caseQty: 12 },
  { sku: 'BBY-6418599', name: 'Apple AirPods Pro (2nd Gen, USB-C)', brand: 'Apple', category: 'audio', unitPrice: 249.99, caseQty: 20 },
  { sku: 'BBY-6505727', name: 'Google Nest Learning Thermostat (4th Gen)', brand: 'Google', category: 'smart-home', unitPrice: 279.99, caseQty: 16 },
];

/**
 * Distribution centers with inventory levels
 */
const DISTRIBUTION_CENTERS = [
  { id: 'DC-FND', name: 'Best Buy DC — Findlay', location: 'Findlay, OH', region: 'midwest', skus: 4120, capacity: 87, fillRate: 98.1, stockouts: 0, status: 'optimal' },
  { id: 'DC-DIN', name: 'Best Buy DC — Dinuba', location: 'Dinuba, CA', region: 'west', skus: 3870, capacity: 92, fillRate: 93.8, stockouts: 4, status: 'stockout' },
  { id: 'DC-ARD', name: 'Best Buy DC — Ardmore', location: 'Ardmore, OK', region: 'south', skus: 3640, capacity: 78, fillRate: 95.4, stockouts: 2, status: 'low-stock' },
  { id: 'DC-STN', name: 'Best Buy DC — Staten Island', location: 'Staten Island, NY', region: 'northeast', skus: 3980, capacity: 71, fillRate: 97.6, stockouts: 1, status: 'optimal' },
  { id: 'DC-NCH', name: 'Best Buy DC — Nichols', location: 'Nichols, SC', region: 'south', skus: 3210, capacity: 65, fillRate: 99.0, stockouts: 0, status: 'optimal' },
  { id: 'DC-BLM', name: 'Best Buy DC — Bloomington', location: 'Bloomington, MN', region: 'midwest', skus: 2980, capacity: 94, fillRate: 96.2, stockouts: 1, status: 'overstock' },
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
    service: 'bestbuy-supply-chain',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const results = queryInventory(queryData.region);
    const aggregated = aggregateRegionMetrics(results);
    const summary = formatQuerySummary(aggregated);

    const duration = Date.now() - startTime;

    incrementMetric('query.success', {
      route: '/api/bestbuy/query',
      region: queryData.region || 'all',
    });
    recordTiming('query.latency', duration, {
      route: '/api/bestbuy/query',
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
      route: '/api/bestbuy/query',
      errorClass: error.name,
    });
    recordTiming('query.latency', duration, {
      route: '/api/bestbuy/query',
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
        route: '/api/bestbuy/query',
        service: 'bestbuy-supply-chain',
        region: queryData.region || 'all',
      },
      extra: { queryId, query: queryData.query },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/bestbuy.js — queryInventory',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: queryData.devinUserId,
      devinEmail: queryData.devinEmail,
      devinOrgId: queryData.devinOrgId,
      customer: 'bestbuy',
      service: 'bestbuy-supply-chain',
      verticalLabel: 'Supply Chain Query',
      tags: [
        { key: 'route', value: '/api/bestbuy/query' },
        { key: 'service', value: 'bestbuy-supply-chain' },
      ],
      extra: { queryId, query: queryData.query },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'bestbuy-supply-chain@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from supply chain query error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processQuery, queryInventory, CATALOG, DISTRIBUTION_CENTERS };
