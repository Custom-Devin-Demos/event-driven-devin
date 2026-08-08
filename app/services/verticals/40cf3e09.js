const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Deployment regions available for a new account activation.
 */
const ACCOUNT_REGIONS = {
  'us-east-1': { region: 'US East (N. Virginia)', zone: 'use1-az1' },
  'us-west-2': { region: 'US West (Oregon)', zone: 'usw2-az2' },
  'eu-west-1': { region: 'EU West (Ireland)', zone: 'euw1-az1' },
  'ap-southeast-1': { region: 'Asia Pacific (Singapore)', zone: 'apse1-az1' },
};

const DEFAULT_REGION_ID = 'us-east-1';

/**
 * Credit terms granted at activation, keyed by plan tier.
 */
const TIER_TERMS = {
  free: { baseCredits: 100, bonusCredits: 0, windowMonths: 1 },
  starter: { baseCredits: 2500, bonusCredits: 250, windowMonths: 6 },
  pro: { baseCredits: 10000, bonusCredits: 2000, windowMonths: 12 },
  enterprise: { baseCredits: 50000, bonusCredits: 15000, windowMonths: 24 },
};

const DEFAULT_PLAN_TIER = 'free';

/**
 * Resolve the deployment region, falling back to the default region.
 */
function resolveRegion(regionId) {
  return ACCOUNT_REGIONS[regionId] || ACCOUNT_REGIONS[DEFAULT_REGION_ID];
}

/**
 * Resolve credit terms for a plan tier, falling back to the default tier.
 */
function resolveTierTerms(planTier) {
  return TIER_TERMS[planTier] || TIER_TERMS[DEFAULT_PLAN_TIER];
}

/**
 * Build the activation package for a resolved region and plan tier.
 */
function buildActivationPackage(regionInfo, planTier) {
  const tierTerms = resolveTierTerms(planTier);
  return {
    accountRegion: regionInfo.region,
    zone: regionInfo.zone,
    totalCredits: tierTerms.baseCredits + tierTerms.bonusCredits,
    expiresInMonths: tierTerms.windowMonths,
  };
}

/**
 * Processes an account activation request.
 */
async function processAccountActivation(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing account activation request', {
    requestId,
    region: data.region,
    planTier: data.planTier,
    service: 'customer-40cf3e09-demo',
    route: '/api/40cf3e09/activate',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const regionInfo = resolveRegion(data.region);
    const activation = buildActivationPackage(regionInfo, data.planTier);

    const summary = {
      requestId,
      activationId: `ACT-${requestId.slice(0, 8).toUpperCase()}`,
      planTier: data.planTier || DEFAULT_PLAN_TIER,
      activation,
      activatedAt: new Date().toISOString(),
    };

    const duration = Date.now() - startTime;

    incrementMetric('account_activation.success', {
      route: '/api/40cf3e09/activate',
      planTier: data.planTier,
    });
    recordTiming('account_activation.latency', duration, {
      route: '/api/40cf3e09/activate',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('account_activation.failure', {
      route: '/api/40cf3e09/activate',
      errorClass: error.name,
    });
    recordTiming('account_activation.latency', duration, {
      route: '/api/40cf3e09/activate',
      error: 'true',
    });

    logger.error('Account activation request failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      region: data.region,
      planTier: data.planTier,
      service: 'customer-40cf3e09-demo',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/40cf3e09/activate',
        service: 'customer-40cf3e09-demo',
        planTier: data.planTier,
      },
      extra: { requestId, region: data.region, planTier: data.planTier },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/40cf3e09.js \u2014 buildActivationPackage',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-40cf3e09-demo',
      verticalLabel: 'Account Activation',
      customer: '40cf3e09',
      tags: [
        { key: 'route', value: '/api/40cf3e09/activate' },
        { key: 'service', value: 'customer-40cf3e09-demo' },
        { key: 'planTier', value: data.planTier },
      ],
      extra: { requestId, region: data.region, planTier: data.planTier },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-40cf3e09-demo@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for account activation error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  processAccountActivation,
  buildActivationPackage,
  resolveRegion,
  resolveTierTerms,
  ACCOUNT_REGIONS,
  TIER_TERMS,
  DEFAULT_PLAN_TIER,
  DEFAULT_REGION_ID,
};
