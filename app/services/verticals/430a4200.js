const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Network regions with coverage and performance data.
 * Each region represents a geographic deployment zone.
 */
const NETWORK_REGIONS = {
  'north-america': {
    name: 'North America',
    subscribers: 12500000,
    towers: 8400,
    performance: { latency: 12, coverage: 0.97, uptime: 0.998 },
  },
  'europe': {
    name: 'Europe',
    subscribers: 9800000,
    towers: 6200,
    performance: { latency: 15, coverage: 0.95, uptime: 0.997 },
  },
  'asia-pacific': {
    name: 'Asia Pacific',
    subscribers: 15200000,
    towers: 11000,
    performance: { latency: 18, coverage: 0.93, uptime: 0.995 },
  },
  'latin-america': {
    name: 'Latin America',
    subscribers: 6400000,
    towers: 3800,
  },
};

/**
 * Infrastructure tier definitions for capacity planning.
 */
const INFRA_TIERS = {
  basic: { capacityMultiplier: 1.0, redundancyLevel: 1, maxLatencyMs: 50 },
  standard: { capacityMultiplier: 1.5, redundancyLevel: 2, maxLatencyMs: 30 },
  enterprise: { capacityMultiplier: 2.5, redundancyLevel: 3, maxLatencyMs: 15 },
};

/**
 * Compute a capacity score for a given region.
 * Evaluates latency, coverage, and subscriber capacity against the infra tier.
 */
function computeCapacityScore(regionData, subscriberCount, infraTier) {
  const tierConfig = INFRA_TIERS[infraTier];
  const adjustedCapacity = subscriberCount * tierConfig.capacityMultiplier;

  if (!regionData.performance) {
    throw new TypeError(
      `Region '${regionData.name}' is missing performance data (latency, coverage, uptime)`,
    );
  }

  const latencyScore = 100 - regionData.performance.latency;
  const coverageScore = regionData.performance.coverage * 100;
  const capacityScore = Math.min(100, (adjustedCapacity / 10000) * tierConfig.redundancyLevel);
  return {
    latency: latencyScore,
    coverage: coverageScore,
    capacity: capacityScore,
    overall: ((latencyScore + coverageScore + capacityScore) / 3).toFixed(1),
  };
}

/**
 * Build a structured assessment report from the computed scores.
 */
function buildNetworkReport(regionData, scores, networkType, infraTier) {
  const tierConfig = INFRA_TIERS[infraTier];
  const overallScore = parseFloat(scores.overall);

  let recommendation;
  if (overallScore >= 85) {
    recommendation = 'OPTIMAL — no changes needed';
  } else if (overallScore >= 70) {
    recommendation = 'ADEQUATE — consider capacity expansion in next quarter';
  } else if (overallScore >= 50) {
    recommendation = 'AT_RISK — schedule infrastructure upgrade';
  } else {
    recommendation = 'CRITICAL — immediate intervention required';
  }

  return {
    region: regionData.name,
    networkType,
    infraTier,
    scores: {
      latency: scores.latency,
      coverage: scores.coverage,
      capacity: scores.capacity,
      overall: overallScore,
    },
    maxLatencyMs: tierConfig.maxLatencyMs,
    redundancyLevel: tierConfig.redundancyLevel,
    recommendation,
  };
}

/**
 * Run a full network capacity assessment for a given region.
 */
async function runAssessment(data) {
  const startTime = Date.now();
  const assessmentId = uuidv4();

  logger.info('Running network capacity assessment', {
    assessmentId,
    region: data.region,
    networkType: data.networkType,
    infraTier: data.infraTier,
    service: '430a4200-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 150));

    const regionConfig = NETWORK_REGIONS[data.region];
    if (!regionConfig) {
      throw new Error(`Unknown region: ${data.region}`);
    }

    const scores = computeCapacityScore(regionConfig, data.subscriberCount, data.infraTier);
    const report = buildNetworkReport(regionConfig, scores, data.networkType, data.infraTier);

    report.assessmentId = assessmentId;
    report.subscriberCount = data.subscriberCount;
    report.completedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('assessment.success', {
      route: '/api/430a4200/assess',
      region: data.region,
    });
    recordTiming('assessment.latency', duration, {
      route: '/api/430a4200/assess',
    });

    return report;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('assessment.failure', {
      route: '/api/430a4200/assess',
      errorClass: error.name,
    });
    recordTiming('assessment.latency', duration, {
      route: '/api/430a4200/assess',
      error: 'true',
    });

    logger.error('Network assessment failed', {
      assessmentId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      region: data.region,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/430a4200/assess',
        service: '430a4200-api',
        region: data.region,
      },
      extra: { assessmentId, infraTier: data.infraTier, networkType: data.networkType, subscriberCount: data.subscriberCount },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/430a4200.js — runAssessment',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      service: '430a4200-api',
      verticalLabel: 'Network Capacity Assessment',
      tags: [
        { key: 'route', value: '/api/430a4200/assess' },
        { key: 'service', value: '430a4200-api' },
      ],
      extra: { assessmentId, region: data.region, networkType: data.networkType },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'acme-checkout@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from assessment error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { runAssessment, NETWORK_REGIONS, INFRA_TIERS };
