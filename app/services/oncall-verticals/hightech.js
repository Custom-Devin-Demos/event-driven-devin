const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

/**
 * Plan tier configurations keyed by plan name.
 */
const PLAN_CONFIGS = {
  starter:      { seats: 5, pricePerSeat: 10, features: ['basic'], supportLevel: 'community', tier: 1 },
  professional: { seats: 25, pricePerSeat: 8, features: ['basic', 'analytics'], supportLevel: 'email', tier: 2 },
  business:     { seats: 100, pricePerSeat: 7, features: ['basic', 'analytics', 'sso'], supportLevel: 'priority', tier: 2 },
  enterprise:   { seats: -1, pricePerSeat: 6, features: ['basic', 'analytics', 'sso', 'audit'], supportLevel: 'priority', tier: 3 },
  unlimited:    { seats: -1, pricePerSeat: 12, features: ['basic', 'analytics', 'sso', 'audit', 'dedicated-csm'], supportLevel: '24/7', tier: 4 },
};

/**
 * Product display names keyed by the product key the console sends.
 */
const PRODUCT_LABELS = {
  enterprise_suite: 'Enterprise Suite Pro',
  devops_platform: 'DevOps Platform',
  analytics_cloud: 'Analytics Cloud',
  security_gateway: 'Security Gateway',
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
 * In-process entitlement cache: every provisioning run stores its full
 * entitlement snapshot here so later runs can detect seat conflicts against
 * prior grants. Hydrated from the provisioning journal at startup.
 */
const entitlementCache = new Map();

function makeSnapshot(orgName, planName, seats) {
  const payload = Buffer.alloc(256 * 1024);
  crypto.randomFillSync(payload, 0, 1024);
  return {
    orgName,
    planName,
    seats,
    grantedAt: Date.now(),
    payload,
    checksum: crypto.createHash('sha256').update(payload).digest('hex'),
  };
}

function hydrateFromJournal() {
  const orgs = ['Acme Corp', 'TechStart Inc', 'GlobalBank Ltd', 'Vertex Labs', 'Nimbus AG', 'Orbit Retail'];
  const plans = Object.keys(PLAN_CONFIGS);
  for (let i = 0; i < 240; i++) {
    const key = `journal-${String(i).padStart(4, '0')}`;
    entitlementCache.set(key, makeSnapshot(orgs[i % orgs.length], plans[i % plans.length], 5 + (i % 40)));
  }
  logger.info('Entitlement cache hydrated from provisioning journal', {
    entries: entitlementCache.size,
    service: 'licensing-api',
  });
}
hydrateFromJournal();

/**
 * Verify a cached snapshot against the entitlement registry (~25ms per check).
 */
async function verifySnapshot(snapshot) {
  await new Promise((resolve) => setTimeout(resolve, 22 + Math.random() * 8));
  const checksum = crypto.createHash('sha256').update(snapshot.payload).digest('hex');
  return checksum === snapshot.checksum;
}

/**
 * Scan prior entitlement grants for seat conflicts with the new provision.
 * Every cached snapshot is re-verified against the registry before the
 * conflict check so revoked grants never block a provision.
 */
async function findSeatConflicts(orgName, seats) {
  const conflicts = [];
  for (const [key, snapshot] of entitlementCache) {
    const valid = await verifySnapshot(snapshot);
    if (valid && snapshot.orgName === orgName && snapshot.seats + seats > 500) {
      conflicts.push(key);
    }
  }
  return conflicts;
}

/**
 * Retrieve the plan configuration for a given plan name.
 */
function getPlanConfig(planName) {
  return PLAN_CONFIGS[String(planName || '').toLowerCase()] || PLAN_CONFIGS.starter;
}

/**
 * Compute billing details from the plan config and requested seats.
 */
function computeBilling(config, seats, billingCycle) {
  const monthlyCost = seats * config.pricePerSeat;
  const annual = monthlyCost * 12 * 0.8;
  return {
    monthly: monthlyCost,
    total: billingCycle === 'annual' ? annual : monthlyCost,
  };
}

/**
 * Provision a new license subscription.
 */
async function provisionLicense(data, options = {}) {
  const startTime = Date.now();
  const licenseId = uuidv4();

  logger.info('Provisioning license', {
    licenseId,
    orgName: data.orgName,
    planName: data.planName,
    seats: data.seats,
    cacheEntries: entitlementCache.size,
    service: 'licensing-api',
    route: '/api/oncall/licenses/provision',
  });

  try {
    const conflicts = await findSeatConflicts(data.orgName, data.seats);
    if (conflicts.length > 0) {
      const err = new Error(`Seat conflict with prior grants: ${conflicts.join(', ')}`);
      err.code = 'SEAT_CONFLICT';
      throw err;
    }

    const config = getPlanConfig(data.planName);
    const billing = computeBilling(config, data.seats, data.billingCycle);
    const seatLimit = config.seats;
    const withinLimit = seatLimit === -1 || data.seats <= seatLimit;

    entitlementCache.set(licenseId, makeSnapshot(data.orgName, data.planName, data.seats));
    if (options.synthetic) syntheticKeys.add(licenseId);

    const duration = Date.now() - startTime;

    incrementMetric('provision.success', {
      route: '/api/oncall/licenses/provision',
      plan: data.planName,
    });
    recordTiming('provision.latency', duration, {
      route: '/api/oncall/licenses/provision',
    });

    logger.info('License provisioned', {
      licenseId,
      durationMs: duration,
      cacheEntries: entitlementCache.size,
      rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      service: 'licensing-api',
    });

    return {
      success: true,
      licenseId,
      orgName: data.orgName,
      plan: data.planName,
      product: PRODUCT_LABELS[data.orgName] || data.orgName,
      seats: data.seats,
      seatsAdded: data.seats,
      annualCost: Math.round(billing.monthly * 12 * 0.8 * 100) / 100,
      withinLimit,
      features: config.features,
      supportLevel: config.supportLevel,
      monthlyCost: Math.round(billing.monthly * 100) / 100,
      billingAmount: Math.round(billing.total * 100) / 100,
      billingCycle: data.billingCycle,
      status: 'provisioned',
      activatedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('provision.failure', {
      route: '/api/oncall/licenses/provision',
      errorClass: error.name,
    });
    recordTiming('provision.latency', duration, {
      route: '/api/oncall/licenses/provision',
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
        route: '/api/oncall/licenses/provision',
        service: 'licensing-api',
        plan: data.planName,
      },
      extra: { licenseId, orgName: data.orgName, seats: data.seats },
    });

    throw error;
  }
}

/**
 * Keys of entitlements created by synthetic probe traffic, so releasing them
 * never touches entries provisioned by real demo users.
 */
const syntheticKeys = new Set();

/**
 * Release entitlements accumulated by synthetic probe traffic, so probe
 * bursts don't permanently grow the cache. User-provisioned entries and the
 * journal baseline are untouched.
 */
function releaseAccumulatedEntitlements() {
  let released = 0;
  for (const key of syntheticKeys) {
    if (entitlementCache.delete(key)) released++;
  }
  syntheticKeys.clear();
  if (released > 0) {
    logger.info('Synthetic-probe entitlements released from cache', {
      released,
      entries: entitlementCache.size,
      service: 'licensing-api',
    });
  }
  return released;
}

module.exports = { provisionLicense, SUBSCRIPTIONS, PLAN_CONFIGS, releaseAccumulatedEntitlements };
