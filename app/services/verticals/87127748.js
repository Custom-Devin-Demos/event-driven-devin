const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const LOCATION_GROUPS = {
  'full-service': ['Downtown Bistro', 'Harborview Grill', 'Uptown Kitchen'],
  'quick-service': ['Midtown Express', 'Airport Counter'],
  'fast-casual': ['Riverside Bowls', 'Campus Eats'],
};

const WEEKLY_LEDGER = {
  'Downtown Bistro': { netSales: 84210.5, foodCost: 24350.2, laborCost: 26120.75 },
  'Harborview Grill': { netSales: 71880.0, foodCost: 21930.4, laborCost: 22610.1 },
  'Uptown Kitchen': { netSales: 65440.25, foodCost: 19105.6, laborCost: 20488.3 },
  'Midtown Express': { netSales: 41220.0, foodCost: 13560.8, laborCost: 10240.5 },
  'Airport Counter': { netSales: 38975.5, foodCost: 12844.3, laborCost: 9861.2 },
  'Riverside Bowls': { netSales: 45310.75, foodCost: 14230.9, laborCost: 12105.6 },
  'Campus Eats': { netSales: 39880.0, foodCost: 12466.2, laborCost: 10744.8 },
};

function loadGroupLedger(locationGroup) {
  const locations = LOCATION_GROUPS[locationGroup] || LOCATION_GROUPS['full-service'];
  return locations.map((name) => {
    const ledger = WEEKLY_LEDGER[name];
    if (!ledger) {
      throw new Error(`No weekly ledger entry for location "${name}"`);
    }
    return { name, ...ledger };
  });
}

function indexCostBuckets(ledgerEntries) {
  const buckets = new Map();
  ledgerEntries.forEach((entry) => {
    buckets.set(entry.name, {
      food: entry.foodCost,
      labor: entry.laborCost,
      sales: entry.netSales,
    });
  });
  return buckets;
}

function computePrimeCost(costIndex, locationName) {
  const bucket = costIndex.get(locationName);
  if (!bucket) {
    throw new Error(`No weekly ledger entry for location "${locationName}"`);
  }
  const prime = bucket.food + bucket.labor;
  return {
    location: locationName,
    primeCost: Number(prime.toFixed(2)),
    primeCostPct: Number(((prime / bucket.sales) * 100).toFixed(1)),
  };
}

function buildInsightsSummary(ledgerEntries, costIndex) {
  const rows = ledgerEntries.map((entry) => computePrimeCost(costIndex, entry.name));
  const totalSales = ledgerEntries.reduce((sum, e) => sum + e.netSales, 0);
  return { rows, totalSales: Number(totalSales.toFixed(2)) };
}

async function processInsightsRequest(data) {
  const requestId = uuidv4();
  const startTime = Date.now();

  logger.info('P&L insights request received', {
    requestId,
    locationGroup: data.locationGroup,
    period: data.period,
  });

  incrementMetric('vertical_87127748.insights.requested', 1, [
    `group:${data.locationGroup}`,
  ]);

  try {
    const ledgerEntries = loadGroupLedger(data.locationGroup);
    const costIndex = indexCostBuckets(ledgerEntries);
    const summary = buildInsightsSummary(ledgerEntries, costIndex);

    recordTiming('vertical_87127748.insights.duration', Date.now() - startTime);
    incrementMetric('vertical_87127748.insights.succeeded', 1);

    logger.info('P&L insights generated', { requestId, locations: summary.rows.length });

    return { success: true, requestId, summary };
  } catch (error) {
    incrementMetric('vertical_87127748.insights.failed', 1, [
      `error:${error.name}`,
    ]);

    logger.error('P&L insights generation failed', {
      requestId,
      error: error.message,
      errorType: error.name,
      locationGroup: data.locationGroup,
      period: data.period,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/87127748/insights',
        service: 'customer-87127748-demo',
        locationGroup: data.locationGroup,
      },
      extra: { requestId, locationGroup: data.locationGroup, period: data.period },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/87127748.js — computePrimeCost',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-87127748-demo',
      verticalLabel: 'P&L Insights Request',
      customer: '87127748',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/87127748/insights' },
        { key: 'service', value: 'customer-87127748-demo' },
        { key: 'locationGroup', value: data.locationGroup },
      ],
      extra: { requestId, locationGroup: data.locationGroup, period: data.period },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-87127748-demo@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for insights error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  processInsightsRequest,
  computePrimeCost,
  indexCostBuckets,
  loadGroupLedger,
  LOCATION_GROUPS,
  WEEKLY_LEDGER,
};
