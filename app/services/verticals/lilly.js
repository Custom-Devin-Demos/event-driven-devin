const { v4: uuidv4 } = require('uuid');
const axios = require('axios');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ONPREM_BASE_URL = process.env.ONPREM_BASE_URL || 'http://localhost:4001';

/**
 * Eli Lilly product catalog — pharma SKUs (NDC codes) across distribution centers.
 */
const CATALOG = [
  { ndc: 'NDC-0002-7510', name: 'Humalog KwikPen 100u/mL', brand: 'Humalog', category: 'insulin', coldChain: true, unitPrice: 274.7 },
  { ndc: 'NDC-0002-1434', name: 'Trulicity 1.5mg/0.5mL', brand: 'Trulicity', category: 'incretin', coldChain: true, unitPrice: 886.9 },
  { ndc: 'NDC-0002-1506', name: 'Zepbound 5mg/0.5mL', brand: 'Zepbound', category: 'incretin', coldChain: true, unitPrice: 1059.9 },
  { ndc: 'NDC-0002-1495', name: 'Mounjaro 7.5mg/0.5mL', brand: 'Mounjaro', category: 'incretin', coldChain: true, unitPrice: 1069.1 },
  { ndc: 'NDC-0002-4112', name: 'Verzenio 150mg', brand: 'Verzenio', category: 'oncology', coldChain: false, unitPrice: 1395.0 },
  { ndc: 'NDC-0002-3227', name: 'Taltz 80mg/mL Autoinjector', brand: 'Taltz', category: 'immunology', coldChain: true, unitPrice: 1730.4 },
  { ndc: 'NDC-0002-7714', name: 'Emgality 120mg/mL', brand: 'Emgality', category: 'neuroscience', coldChain: true, unitPrice: 689.5 },
];

/**
 * Distribution centers with inventory + cold-chain status.
 */
const DISTRIBUTION_CENTERS = [
  { id: 'DC-IND', name: 'Lilly DC — Indianapolis', location: 'Indianapolis, IN', region: 'midwest', skus: 412, capacity: 88, fillRate: 98.4, stockouts: 0, coldChainC: 4.6, status: 'optimal' },
  { id: 'DC-BRB', name: 'Lilly DC — Branchburg', location: 'Branchburg, NJ', region: 'northeast', skus: 356, capacity: 91, fillRate: 93.7, stockouts: 2, coldChainC: 5.1, status: 'low-stock' },
  { id: 'DC-CON', name: 'Lilly DC — Concord', location: 'Concord, NC', region: 'south', skus: 388, capacity: 79, fillRate: 95.1, stockouts: 3, coldChainC: 5.4, status: 'stockout' },
  { id: 'DC-KC', name: 'Lilly DC — Kansas City', location: 'Kansas City, MO', region: 'midwest', skus: 301, capacity: 72, fillRate: 97.6, stockouts: 1, coldChainC: 4.9, status: 'optimal' },
  { id: 'DC-SAC', name: 'Lilly DC — Sacramento', location: 'Sacramento, CA', region: 'west', skus: 264, capacity: 84, fillRate: 96.0, stockouts: 1, coldChainC: 7.8, status: 'excursion' },
  { id: 'DC-MEM', name: 'Lilly DC — Memphis', location: 'Memphis, TN', region: 'south', skus: 295, capacity: 67, fillRate: 99.0, stockouts: 0, coldChainC: 5.0, status: 'optimal' },
];

/**
 * Pulls live stock from the LEGACY ON-PREM inventory service. Falls back to the
 * locally cached distribution-center data if the on-prem system is unreachable
 * (demo continues to work without the on-prem container running).
 */
async function fetchOnPremInventory() {
  try {
    const res = await axios.get(`${ONPREM_BASE_URL}/legacy/inventory`, { timeout: 1500 });
    logger.info('Fetched inventory from on-prem legacy system', {
      source: res.data && res.data.source,
      recordCount: res.data && res.data.recordCount,
      service: 'lilly-supply-chain',
    });
    return res.data;
  } catch (err) {
    logger.warn('On-prem legacy inventory unreachable — using cached cloud data', {
      error: err.message,
      onpremUrl: ONPREM_BASE_URL,
      service: 'lilly-supply-chain',
    });
    return null;
  }
}

/**
 * Queries inventory status for a given region.
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
    coldChainC: dc.coldChainC,
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
    avgFillRate: aggregated.metrics.fillRate,
    totalStockouts: aggregated.metrics.stockouts,
    totalDCs: aggregated.metrics.dcCount,
  };
}

/**
 * Process a supply chain query (simulates NL query against the cloud dashboard
 * backed by the on-prem legacy inventory system).
 */
async function processQuery(queryData) {
  const startTime = Date.now();
  const queryId = uuidv4();

  logger.info('Processing pharma supply chain query', {
    queryId,
    query: queryData.query,
    region: queryData.region,
    service: 'lilly-supply-chain',
  });

  try {
    await fetchOnPremInventory();

    const results = queryInventory(queryData.region);
    const aggregated = aggregateRegionMetrics(results);
    const summary = formatQuerySummary(aggregated);

    const duration = Date.now() - startTime;

    incrementMetric('query.success', {
      route: '/api/lilly/query',
      region: queryData.region || 'all',
    });
    recordTiming('query.latency', duration, {
      route: '/api/lilly/query',
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
      route: '/api/lilly/query',
      errorClass: error.name,
    });
    recordTiming('query.latency', duration, {
      route: '/api/lilly/query',
      error: 'true',
    });

    logger.error('Pharma supply chain query failed', {
      queryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/lilly/query',
        service: 'lilly-supply-chain',
        region: queryData.region || 'all',
      },
      extra: { queryId, query: queryData.query },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/lilly.js — queryInventory',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: queryData.devinUserId,
      devinEmail: queryData.devinEmail,
      devinOrgId: queryData.devinOrgId,
      service: 'lilly-supply-chain',
      verticalLabel: 'Supply Chain Query',
      tags: [
        { key: 'route', value: '/api/lilly/query' },
        { key: 'service', value: 'lilly-supply-chain' },
      ],
      extra: { queryId, query: queryData.query },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'lilly-supply-chain@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from pharma supply chain query error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processQuery, queryInventory, fetchOnPremInventory, CATALOG, DISTRIBUTION_CENTERS };
