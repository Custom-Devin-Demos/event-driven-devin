const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Sysco product catalog — broadline foodservice SKUs across distribution centers
 */
const CATALOG = [
  { sku: 'SUPC-1879325', name: 'Sysco Imperial Boneless Skinless Chicken Breast 6oz', brand: 'Sysco Imperial', category: 'protein', unitPrice: 89.50, caseQty: 4 },
  { sku: 'SUPC-4412098', name: 'Buckhead Pride Ground Beef 80/20 Chub', brand: 'Buckhead Pride', category: 'protein', unitPrice: 64.25, caseQty: 8 },
  { sku: 'SUPC-6601122', name: 'Portico Atlantic Salmon Fillet 10lb', brand: 'Portico', category: 'seafood', unitPrice: 118.00, caseQty: 1 },
  { sku: 'SUPC-2255010', name: 'Sysco Reliance Russet Potatoes 70ct', brand: 'Sysco Reliance', category: 'produce', unitPrice: 28.40, caseQty: 1 },
  { sku: 'SUPC-7700321', name: 'Sysco Classic Romaine Hearts 6/3ct', brand: 'Sysco Classic', category: 'produce', unitPrice: 31.75, caseQty: 6 },
  { sku: 'SUPC-5512033', name: 'Arrezzio Shredded Mozzarella 4/5lb', brand: 'Arrezzio', category: 'dairy', unitPrice: 72.90, caseQty: 4 },
  { sku: 'SUPC-3344567', name: 'Wholesome Farms Large Eggs 15dz', brand: 'Wholesome Farms', category: 'dairy', unitPrice: 42.10, caseQty: 1 },
  { sku: 'SUPC-8800450', name: 'Sysco Classic Canola Oil 35lb JIB', brand: 'Sysco Classic', category: 'dry', unitPrice: 38.60, caseQty: 1 },
  { sku: 'SUPC-9912230', name: 'Casa Solana Flour Tortillas 12/12ct', brand: 'Casa Solana', category: 'dry', unitPrice: 24.95, caseQty: 12 },
];

/**
 * Distribution centers with inventory levels
 */
const DISTRIBUTION_CENTERS = [
  { id: 'SDC-HOU', name: 'Sysco DC — Houston', location: 'Houston, TX', region: 'south', skus: 15820, capacity: 88, fillRate: 98.0, stockouts: 0, status: 'optimal' },
  { id: 'SDC-RIV', name: 'Sysco DC — Riverside', location: 'Riverside, CA', region: 'west', skus: 14310, capacity: 93, fillRate: 93.6, stockouts: 4, status: 'stockout' },
  { id: 'SDC-ATL', name: 'Sysco DC — Atlanta', location: 'College Park, GA', region: 'south', skus: 14890, capacity: 79, fillRate: 95.3, stockouts: 2, status: 'low-stock' },
  { id: 'SDC-CHI', name: 'Sysco DC — Chicago', location: 'Des Plaines, IL', region: 'midwest', skus: 15240, capacity: 72, fillRate: 97.5, stockouts: 1, status: 'optimal' },
  { id: 'SDC-BOS', name: 'Sysco DC — Boston', location: 'Plympton, MA', region: 'northeast', skus: 13680, capacity: 66, fillRate: 98.9, stockouts: 0, status: 'optimal' },
  { id: 'SDC-DEN', name: 'Sysco DC — Denver', location: 'Denver, CO', region: 'west', skus: 12450, capacity: 94, fillRate: 96.1, stockouts: 1, status: 'overstock' },
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
    service: 'sysco-supply-chain',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const results = queryInventory(queryData.region);
    const aggregated = aggregateRegionMetrics(results);
    const summary = formatQuerySummary(aggregated);

    const duration = Date.now() - startTime;

    incrementMetric('query.success', {
      route: '/api/sysco/query',
      region: queryData.region || 'all',
    });
    recordTiming('query.latency', duration, {
      route: '/api/sysco/query',
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
      route: '/api/sysco/query',
      errorClass: error.name,
    });
    recordTiming('query.latency', duration, {
      route: '/api/sysco/query',
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
        route: '/api/sysco/query',
        service: 'sysco-supply-chain',
        region: queryData.region || 'all',
      },
      extra: { queryId, query: queryData.query },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/sysco.js — queryInventory',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: queryData.devinUserId,
      devinEmail: queryData.devinEmail,
      devinOrgId: queryData.devinOrgId,
      customer: 'sysco',
      service: 'sysco-supply-chain',
      verticalLabel: 'Supply Chain Query',
      tags: [
        { key: 'route', value: '/api/sysco/query' },
        { key: 'service', value: 'sysco-supply-chain' },
      ],
      extra: { queryId, query: queryData.query },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'sysco-supply-chain@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from supply chain query error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processQuery, queryInventory, CATALOG, DISTRIBUTION_CENTERS };
