const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const DEFAULT_REGIONS = ['ES', 'DE', 'UK', 'BR', 'HISPAM'];

const MARKETS = {
  ES: { name: 'España', accesses: 27.4, revenueEur: 3.1 },
  DE: { name: 'Alemania', accesses: 46.9, revenueEur: 2.0 },
  UK: { name: 'Reino Unido', accesses: 24.3, revenueEur: 1.8 },
  BR: { name: 'Brasil', accesses: 112.6, revenueEur: 2.3 },
  HISPAM: { name: 'HispAm', accesses: 118.1, revenueEur: 2.6 },
};

function normalizeRegions(regions) {
  return regions.map((region) => region.toLowerCase());
}

function collectFigures(codes) {
  return codes.map((code) => ({ code, ...MARKETS[code] }));
}

function buildKpiSummary(figures) {
  const totalRevenueEur = DEFAULT_REGIONS.reduce(
    (sum, code) => sum + figures[code].revenueEur,
    0
  );
  const totalAccesses = DEFAULT_REGIONS.reduce(
    (sum, code) => sum + figures[code].accesses,
    0
  );

  return {
    totalAccesses,
    totalRevenueEur,
    perMarket: figures,
  };
}

async function processKeyMetricsRequest(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const regions = data.regions || DEFAULT_REGIONS;

  logger.info('Processing Telefónica key metrics request', {
    requestId,
    regions,
    service: 'customer-bec5e1bb-metrics',
    route: '/api/bec5e1bb/metrics',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const codes = normalizeRegions(data.regions || DEFAULT_REGIONS);
    const figures = collectFigures(codes);
    const summary = buildKpiSummary(figures);

    const result = {
      ...summary,
      requestId,
      generatedAt: new Date().toISOString(),
    };
    const duration = Date.now() - startTime;

    incrementMetric('key_metrics.success', {
      route: '/api/bec5e1bb/metrics',
    });
    recordTiming('key_metrics.latency', duration, {
      route: '/api/bec5e1bb/metrics',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('key_metrics.failure', {
      route: '/api/bec5e1bb/metrics',
      errorClass: error.name,
    });
    recordTiming('key_metrics.latency', duration, {
      route: '/api/bec5e1bb/metrics',
      error: 'true',
    });

    logger.error('Telefónica key metrics request failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      regions,
      service: 'customer-bec5e1bb-metrics',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/bec5e1bb/metrics',
        service: 'customer-bec5e1bb-metrics',
      },
      extra: { requestId, regions },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/bec5e1bb.js — buildKpiSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: 'jaime@cognition.ai',
      devinOrgId: data.devinOrgId,
      service: 'customer-bec5e1bb-metrics',
      verticalLabel: 'Movistar Fibra 1Gb',
      customer: 'bec5e1bb',
      tags: [
        { key: 'route', value: '/api/bec5e1bb/metrics' },
        { key: 'service', value: 'customer-bec5e1bb-metrics' },
      ],
      extra: { requestId, regions, region: regions },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-bec5e1bb-metrics@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for key metrics error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processKeyMetricsRequest, MARKETS };
