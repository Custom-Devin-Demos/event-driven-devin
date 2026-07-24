const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Public mission briefing catalog keyed by domain.
 */
const MISSION_DOMAINS = {
  space: {
    label: 'Space Systems',
    programs: [
      { id: 'satellite-servicing', title: 'Evolving Satellite Servicing', sensors: 14 },
      { id: 'arctic-broadband', title: 'Arctic Satellite Broadband Mission', sensors: 9 },
    ],
  },
  'advanced-weapons': {
    label: 'Advanced Weapons',
    programs: [
      { id: 'sentinel-icbm', title: 'Sentinel ICBM: Peace Through Power', sensors: 21 },
      { id: 'counter-uas', title: 'Defeating Drone Threats', sensors: 12 },
    ],
  },
  aeronautics: {
    label: 'Aeronautics Systems',
    programs: [
      { id: 'command-control', title: 'Future Ready Command and Control', sensors: 17 },
      { id: 'american-defense', title: 'The Future of American Defense', sensors: 11 },
    ],
  },
};

const CLEARANCE_TIERS = {
  public: { maxPrograms: 2, redactSensorCounts: true },
  partner: { maxPrograms: 4, redactSensorCounts: false },
};

/**
 * Group briefing programs by mission domain for coverage rollups.
 */
function groupProgramsByDomain(domains) {
  const grouped = new Map();
  for (const [key, domain] of Object.entries(domains)) {
    grouped.set(key, {
      label: domain.label,
      programCount: domain.programs.length,
      sensorTotal: domain.programs.reduce((sum, p) => sum + p.sensors, 0),
    });
  }
  return grouped;
}

/**
 * Compute readiness coverage percentages across grouped domains.
 */
function computeCoverage(grouped) {
  const coverage = {};
  let totalSensors = 0;
  for (const entry of Object.values(grouped)) {
    totalSensors += entry.sensorTotal;
  }
  for (const [key, entry] of Object.entries(grouped)) {
    coverage[key] = {
      label: entry.label,
      percent: totalSensors ? (entry.sensorTotal / totalSensors) * 100 : 0,
    };
  }
  return coverage;
}

/**
 * Format the coverage summary for the requested domain.
 */
function formatBriefing(coverage, domainKey, tier) {
  const domainCoverage = coverage[domainKey];
  return {
    domain: domainCoverage.label,
    coveragePercent: `${domainCoverage.percent.toFixed(1)}%`,
    programLimit: tier.maxPrograms,
    sensorCountsRedacted: tier.redactSensorCounts,
  };
}

/**
 * Processes a mission briefing request.
 */
async function processMissionBriefing(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing mission briefing request', {
    requestId,
    domain: data.domain,
    clearanceTier: data.clearanceTier,
    service: 'customer-e1da8ec4-demo',
    route: '/api/e1da8ec4/mission-briefing',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const domainKey = MISSION_DOMAINS[data.domain] ? data.domain : 'space';
    const tier = CLEARANCE_TIERS[data.clearanceTier] || CLEARANCE_TIERS.public;

    const grouped = groupProgramsByDomain(MISSION_DOMAINS);
    const coverage = computeCoverage(grouped);
    const briefing = formatBriefing(coverage, domainKey, tier);

    const summary = {
      requestId,
      briefing,
      generatedAt: new Date().toISOString(),
    };

    const duration = Date.now() - startTime;

    incrementMetric('mission_briefing.success', {
      route: '/api/e1da8ec4/mission-briefing',
      domain: data.domain,
    });
    recordTiming('mission_briefing.latency', duration, {
      route: '/api/e1da8ec4/mission-briefing',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('mission_briefing.failure', {
      route: '/api/e1da8ec4/mission-briefing',
      errorClass: error.name,
    });
    recordTiming('mission_briefing.latency', duration, {
      route: '/api/e1da8ec4/mission-briefing',
      error: 'true',
    });

    logger.error('Mission briefing request failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      domain: data.domain,
      clearanceTier: data.clearanceTier,
      service: 'customer-e1da8ec4-demo',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/e1da8ec4/mission-briefing',
        service: 'customer-e1da8ec4-demo',
        domain: data.domain,
      },
      extra: { requestId, domain: data.domain, clearanceTier: data.clearanceTier },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/e1da8ec4.js \u2014 computeCoverage',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-e1da8ec4-demo',
      verticalLabel: 'Mission Briefing Request',
      customer: 'e1da8ec4',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/e1da8ec4/mission-briefing' },
        { key: 'service', value: 'customer-e1da8ec4-demo' },
        { key: 'domain', value: data.domain },
      ],
      extra: { requestId, domain: data.domain, clearanceTier: data.clearanceTier },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-e1da8ec4-demo@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for mission briefing error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processMissionBriefing, MISSION_DOMAINS, CLEARANCE_TIERS };
