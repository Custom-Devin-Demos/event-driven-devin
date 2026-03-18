const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Plan tier configurations keyed by plan name.
 */
const PLAN_CONFIGS = {
  starter:      { seats: 5, pricePerSeat: 10, features: ['basic'], supportLevel: 'community', tier: 1 },
  professional: { seats: 25, pricePerSeat: 8, features: ['basic', 'analytics'], supportLevel: 'email', tier: 2 },
  enterprise:   { seats: -1, pricePerSeat: 6, features: ['basic', 'analytics', 'sso', 'audit'], supportLevel: 'priority', tier: 3 },
  unlimited:    { seats: -1, pricePerSeat: 12, features: ['basic', 'analytics', 'sso', 'audit', 'dedicated-csm'], supportLevel: '24/7', tier: 4 },
};

/**
 * Active subscriptions for the demo
 */
const SUBSCRIPTIONS = [
  { id: 'SUB-7001', orgName: 'Acme Corp', plan: 'professional', seats: 18, usedSeats: 14, billingCycle: 'annual', status: 'active' },
  { id: 'SUB-7002', orgName: 'TechStart Inc', plan: 'starter', seats: 5, usedSeats: 5, billingCycle: 'monthly', status: 'active' },
  { id: 'SUB-7003', orgName: 'GlobalBank Ltd', plan: 'enterprise', seats: 200, usedSeats: 163, billingCycle: 'annual', status: 'active' },
];

/**
 * Retrieve the plan configuration for a given plan name.
 */
function getPlanConfig(planName) {
  if (!planName) return undefined;
  return PLAN_CONFIGS[planName.toLowerCase()];
}

/**
 * Compute billing details from the plan config and requested seats.
 */
function computeBilling(config, seats, billingCycle) {
  const monthlyCost = seats * config.pricePerSeat;
  const annual = monthlyCost * 12 * 0.8;
  return {
    costs: { monthly: monthlyCost, annual },
    selected: billingCycle === 'annual' ? annual : monthlyCost,
  };
}

/**
 * Provision a new license subscription.
 */
async function provisionLicense(data) {
  const startTime = Date.now();
  const licenseId = uuidv4();

  logger.info('Provisioning license', {
    licenseId,
    orgName: data.orgName,
    planName: data.planName,
    seats: data.seats,
    service: 'licensing-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 130));

    const config = getPlanConfig(data.planName);
    if (!config) {
      throw new Error(`Unknown plan: '${data.planName}'. Valid plans: ${Object.keys(PLAN_CONFIGS).join(', ')}`);
    }
    const billing = computeBilling(config, data.seats, data.billingCycle);
    const seatLimit = config.seats;
    const withinLimit = seatLimit === -1 || data.seats <= seatLimit;

    const duration = Date.now() - startTime;

    incrementMetric('provision.success', {
      route: '/api/licenses/provision',
      plan: data.planName,
    });
    recordTiming('provision.latency', duration, {
      route: '/api/licenses/provision',
    });

    return {
      success: true,
      licenseId,
      orgName: data.orgName,
      plan: data.planName,
      seats: data.seats,
      withinLimit,
      features: config.features,
      supportLevel: config.supportLevel,
      pricePerSeat: config.pricePerSeat,
      monthlyCost: Math.round(billing.costs.monthly * 100) / 100,
      billingAmount: Math.round(billing.selected * 100) / 100,
      billingCycle: data.billingCycle,
      status: 'provisioned',
      activatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('provision.failure', {
      route: '/api/licenses/provision',
      errorClass: error.name,
    });
    recordTiming('provision.latency', duration, {
      route: '/api/licenses/provision',
      error: 'true',
    });

    logger.error('License provisioning failed', {
      licenseId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      orgName: data.orgName,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/licenses/provision',
        service: 'licensing-api',
        plan: data.planName,
      },
      extra: { licenseId, orgName: data.orgName, seats: data.seats },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/hightech.js — provisionLicense',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'licensing-api',
      verticalLabel: 'License Provisioning',
      tags: [
        { key: 'route', value: '/api/licenses/provision' },
        { key: 'service', value: 'licensing-api' },
      ],
      extra: { licenseId, orgName: data.orgName, seats: data.seats },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'novasoft@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from provisioning error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { provisionLicense, SUBSCRIPTIONS, PLAN_CONFIGS };
