const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const NETWORK_REGIONS = {
  'NORTH_AMERICA': { latencyBaseline: 12, coverageIndex: 0.97, regulatoryFactor: 1.0 },
  'EUROPE': { latencyBaseline: 14, coverageIndex: 0.95, regulatoryFactor: 1.1 },
  'ASIA_PACIFIC': { latencyBaseline: 18, coverageIndex: 0.89, regulatoryFactor: 0.9 },
  'LATIN_AMERICA': { latencyBaseline: 22, coverageIndex: 0.82, regulatoryFactor: 0.85 },
  'MIDDLE_EAST_AFRICA': { latencyBaseline: 26, coverageIndex: 0.74, regulatoryFactor: 0.8 },
};

const INFRA_TIERS = {
  enterprise: { capacityMultiplier: 1.0, redundancyLevel: 2, slaceiling: 99.9 },
  carrier: { capacityMultiplier: 1.5, redundancyLevel: 3, slaceiling: 99.99 },
  hyperscale: { capacityMultiplier: 2.5, redundancyLevel: 4, slaceiling: 99.999 },
};

const NETWORK_TYPES = {
  '5G-SA': { throughputBase: 1000, spectrumEfficiency: 0.92 },
  '5G-NSA': { throughputBase: 600, spectrumEfficiency: 0.78 },
  '4G-LTE': { throughputBase: 150, spectrumEfficiency: 0.65 },
  'ORAN': { throughputBase: 800, spectrumEfficiency: 0.88 },
};

async function resolveRegionConfig(regionId) {
  const key = regionId.replace(/-/g, '_').toUpperCase();
  const region = NETWORK_REGIONS[key];
  if (!region) return null;
  return {
    metrics: {
      latency: region.latencyBaseline,
      coverage: region.coverageIndex,
    },
    compliance: {
      factor: region.regulatoryFactor,
    },
  };
}

function computeCapacityScore(regionData, subscriberCount, infraTier) {
  const tierConfig = INFRA_TIERS[infraTier];
  const adjustedCapacity = subscriberCount * tierConfig.capacityMultiplier;
  const latencyScore = 100 - regionData.performance.latency;
  const coverageScore = regionData.performance.coverage * 100;
  const capacityScore = Math.min(100, (adjustedCapacity / 10000) * tierConfig.redundancyLevel);
  return {
    latency: latencyScore,
    coverage: coverageScore,
    capacity: capacityScore,
    tier: infraTier,
  };
}

async function evaluateNetworkReadiness(scores, networkType, targetUptime) {
  const networkConfig = NETWORK_TYPES[networkType];
  const throughput = networkConfig.throughputBase * networkConfig.spectrumEfficiency;
  const compositeScore = (scores.latency * 0.3 + scores.coverage * 0.4 + scores.capacity * 0.3).toFixed(1);
  const readinessLevel = compositeScore >= 85 ? 'Production Ready' :
    compositeScore >= 70 ? 'Pilot Ready' : 'Requires Optimization';

  return {
    score: compositeScore,
    readiness: readinessLevel,
    throughputEstimate: `${throughput.toFixed(0)} Mbps`,
    slaFeasibility: targetUptime <= INFRA_TIERS[scores.tier].slaceiling ? 'Achievable' : 'At Risk',
  };
}

async function runAssessment(data) {
  const startTime = Date.now();
  const assessmentId = uuidv4();

  logger.info('Running network assessment', {
    assessmentId,
    region: data.networkRegion,
    networkType: data.networkType,
    service: '430a4200-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 100 + Math.random() * 150));

    const regionConfig = resolveRegionConfig(data.networkRegion);
    const scores = computeCapacityScore(regionConfig, data.subscriberCount, data.infraTier);
    const readiness = await evaluateNetworkReadiness(scores, data.networkType, data.targetUptime);

    const duration = Date.now() - startTime;

    incrementMetric('assessment.success', {
      route: '/api/430a4200/assess',
      region: data.networkRegion,
    });
    recordTiming('assessment.latency', duration, {
      route: '/api/430a4200/assess',
    });

    return {
      success: true,
      assessmentId,
      score: readiness.score,
      readiness: readiness.readiness,
      throughput: readiness.throughputEstimate,
      slaFeasibility: readiness.slaFeasibility,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('assessment.failure', {
      route: '/api/430a4200/assess',
      errorClass: error.name,
      region: data.networkRegion,
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
      region: data.networkRegion,
      networkType: data.networkType,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/430a4200/assess',
        service: '430a4200-api',
        region: data.networkRegion,
      },
      extra: {
        assessmentId,
        networkType: data.networkType,
        subscriberCount: data.subscriberCount,
        infraTier: data.infraTier,
      },
    });

    createSessionAndAlert({
      customer: '430a4200',
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/430a4200.js — runAssessment',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: '430a4200-api',
      verticalLabel: 'Network Assessment',
      tags: [
        { key: 'route', value: '/api/430a4200/assess' },
        { key: 'service', value: '430a4200-api' },
        { key: 'region', value: data.networkRegion },
      ],
      extra: { assessmentId, networkType: data.networkType, subscriberCount: data.subscriberCount, infraTier: data.infraTier },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '430a4200-npa@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from assessment error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { runAssessment, NETWORK_REGIONS, INFRA_TIERS, NETWORK_TYPES };
