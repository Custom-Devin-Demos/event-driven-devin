const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * CloudSuite catalog with per-industry modules and deployment footprints.
 */
const CLOUDSUITES = {
  'industrial-manufacturing': {
    label: 'CloudSuite Industrial Enterprise',
    modules: ['erp', 'scm', 'plm', 'mes'],
    deployment: {
      regions: [
        { id: 'us-east', capacity: 120, latencyMs: 18 },
        { id: 'eu-west', capacity: 90, latencyMs: 24 },
      ],
      tier: 'multi-tenant',
    },
  },
  'distribution': {
    label: 'CloudSuite Distribution',
    modules: ['erp', 'scm', 'wms'],
    deployment: {
      regions: [
        { id: 'us-east', capacity: 100, latencyMs: 20 },
        { id: 'ap-south', capacity: 60, latencyMs: 38 },
      ],
      tier: 'multi-tenant',
    },
  },
  'food-beverage': {
    label: 'CloudSuite Food & Beverage',
    modules: ['erp', 'scm', 'quality'],
    deployment: {
      regions: [
        { id: 'us-east', capacity: 80, latencyMs: 21 },
        { id: 'eu-west', capacity: 70, latencyMs: 26 },
      ],
      tier: 'multi-tenant',
    },
  },
  'healthcare': {
    label: 'CloudSuite Healthcare',
    modules: ['erp', 'hcm', 'financials'],
    deployment: {
      regions: [
        { id: 'us-east', capacity: 110, latencyMs: 17 },
      ],
      tier: 'dedicated',
    },
  },
};

/**
 * Velocity Suite add-ons bundled with every demo environment.
 */
const VELOCITY_ADDONS = [
  { id: 'industry-agents', label: 'Industry AI Agents', provisioningMinutes: 6 },
  { id: 'adaptive-ux', label: 'Adaptive Experiences', provisioningMinutes: 4 },
  { id: 'orchestrator', label: 'Agentic Orchestrator', provisioningMinutes: 9 },
];

/**
 * Resolve the CloudSuite catalog entry for an industry selection.
 */
function resolveSuite(industry) {
  const key = String(industry || '').trim().toLowerCase().replace(/\s+/g, '-');
  return { key, suite: CLOUDSUITES[key] };
}

/**
 * Build the deployment plan for the requested modules and region.
 */
function buildDeploymentPlan(resolved, region, requestedModules) {
  if (!resolved.suite) {
    throw new Error(`Unknown CloudSuite industry: ${resolved.key}`);
  }

  const { modules, deployment } = resolved.suite;
  const activeModules = requestedModules.filter((m) => modules.includes(m));
  const target = deployment.regions.find((r) => r.id === region) || deployment.regions[0];

  return {
    suiteKey: resolved.key,
    tier: deployment.tier,
    region: target.id,
    capacity: target.capacity,
    latencyMs: target.latencyMs,
    modules: activeModules.length ? activeModules : modules,
  };
}

/**
 * Estimate the environment readiness window from the deployment plan.
 */
function estimateReadiness(plan) {
  const baseMinutes = plan.tier === 'dedicated' ? 45 : 25;
  const moduleMinutes = plan.modules.length * 7;
  const addonMinutes = VELOCITY_ADDONS.reduce((sum, a) => sum + a.provisioningMinutes, 0);
  const totalMinutes = baseMinutes + moduleMinutes + addonMinutes;

  return {
    baseMinutes,
    moduleMinutes,
    addonMinutes,
    totalMinutes,
    readyBy: new Date(Date.now() + totalMinutes * 60000).toISOString(),
  };
}

/**
 * Processes a demo environment request.
 */
async function processDemoRequest(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing demo environment request', {
    requestId,
    industry: data.industry,
    region: data.region,
    service: 'customer-8c0e99b1-demo',
    route: '/api/8c0e99b1/demo-request',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const resolved = resolveSuite(data.industry);
    const plan = buildDeploymentPlan(resolved, data.region, data.modules || []);
    const readiness = estimateReadiness(plan);

    const summary = {
      requestId,
      suite: resolved.suite.label,
      plan,
      readiness,
      addons: VELOCITY_ADDONS.map((a) => a.label),
      requestedAt: new Date().toISOString(),
    };

    const duration = Date.now() - startTime;

    incrementMetric('demo_request.success', {
      route: '/api/8c0e99b1/demo-request',
      industry: data.industry,
    });
    recordTiming('demo_request.latency', duration, {
      route: '/api/8c0e99b1/demo-request',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('demo_request.failure', {
      route: '/api/8c0e99b1/demo-request',
      errorClass: error.name,
    });
    recordTiming('demo_request.latency', duration, {
      route: '/api/8c0e99b1/demo-request',
      error: 'true',
    });

    logger.error('Demo environment request failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      industry: data.industry,
      region: data.region,
      service: 'customer-8c0e99b1-demo',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/8c0e99b1/demo-request',
        service: 'customer-8c0e99b1-demo',
        industry: data.industry,
      },
      extra: { requestId, industry: data.industry, region: data.region },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/8c0e99b1.js \u2014 buildDeploymentPlan',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-8c0e99b1-demo',
      verticalLabel: 'Demo Environment Request',
      customer: '8c0e99b1',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/8c0e99b1/demo-request' },
        { key: 'service', value: 'customer-8c0e99b1-demo' },
        { key: 'industry', value: data.industry },
      ],
      extra: { requestId, industry: data.industry, region: data.region },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-8c0e99b1-demo@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for demo request error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  processDemoRequest,
  resolveSuite,
  buildDeploymentPlan,
  CLOUDSUITES,
  VELOCITY_ADDONS,
};
