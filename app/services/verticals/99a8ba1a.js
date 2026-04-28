const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const PLANS = {
  rider: { label: 'Rider', monthlyFee: 0, rideCredits: 10, surgeProtection: false },
  'rider-plus': { label: 'Rider Plus', monthlyFee: 9.99, rideCredits: 30, surgeProtection: true },
  driver: { label: 'Driver', monthlyFee: 0, rideCredits: 0, surgeProtection: false },
  fleet: { label: 'Fleet Manager', monthlyFee: 49.99, rideCredits: 0, surgeProtection: false },
};

const REGIONS = {
  'us-west': { name: 'US West', cities: ['San Francisco', 'Los Angeles', 'Seattle', 'Portland'], active: true },
  'us-east': { name: 'US East', cities: ['New York', 'Boston', 'Miami', 'Atlanta'], active: true },
  'us-central': { name: 'US Central', cities: ['Chicago', 'Dallas', 'Denver', 'Austin'], active: true },
  'eu-west': { name: 'EU West', cities: ['London', 'Paris', 'Amsterdam', 'Dublin'], active: true },
};

const SIGNUP_QUOTAS = {
  rider: { total: 50000, used: 42150 },
  'rider-plus': { total: 10000, used: 6800 },
  driver: { total: 25000, used: 18900 },
  fleet: { total: 500, used: 320 },
};

const PROMO_CODES = {
  SWIFT10: { discount: 0.10, validPlans: ['rider-plus'], description: '10% off first 3 months' },
  DRIVE2026: { discount: 0.15, validPlans: ['driver'], description: '15% commission reduction' },
  FLEET50: { discount: 0.20, validPlans: ['fleet'], description: '20% off fleet subscription' },
};

function lookupPlan(planId) {
  const plan = PLANS[planId];
  if (!plan) return null;
  return {
    id: planId,
    details: {
      label: plan.label,
      monthlyFee: plan.monthlyFee,
      rideCredits: plan.rideCredits,
      surgeProtection: plan.surgeProtection,
    },
  };
}

function getSignupQuota(planId) {
  const quota = SIGNUP_QUOTAS[planId];
  if (!quota) return null;
  const remaining = quota.total - quota.used;
  return {
    allocation: {
      remaining,
      total: quota.total,
      used: quota.used,
      utilization: ((quota.used / quota.total) * 100).toFixed(1),
    },
  };
}

function validateRegion(regionCode) {
  const region = REGIONS[regionCode];
  if (!region) return { valid: false, region: null };
  return {
    valid: region.active,
    region: {
      code: regionCode,
      name: region.name,
      cities: region.cities,
    },
  };
}

function applyPromoCode(promoCode, planId) {
  if (!promoCode) return { applied: false, discount: 0 };
  const promo = PROMO_CODES[promoCode.toUpperCase()];
  if (!promo) return { applied: false, discount: 0, reason: 'Invalid promo code' };
  if (!promo.validPlans.includes(planId)) {
    return { applied: false, discount: 0, reason: `Promo not valid for ${planId} plan` };
  }
  return { applied: true, discount: promo.discount, description: promo.description };
}

function buildSignupResponse(planInfo, quotaInfo, regionInfo, promoResult) {
  const monthlyFee = planInfo.details.monthlyFee;
  const discountedFee = promoResult.applied
    ? monthlyFee * (1 - promoResult.discount)
    : monthlyFee;

  return {
    plan: planInfo.details.label,
    planId: planInfo.id,
    monthlyFee: monthlyFee.toFixed(2),
    discountedFee: discountedFee.toFixed(2),
    rideCredits: planInfo.details.rideCredits,
    surgeProtection: planInfo.details.surgeProtection,
    region: regionInfo.region.name,
    spotsRemaining: quotaInfo.allocation.remaining,
    quotaUtilization: quotaInfo.allocation.utilization,
    promo: promoResult.applied ? promoResult.description : null,
  };
}

async function processSignup(data) {
  const startTime = Date.now();
  const signupId = uuidv4();

  logger.info('Processing rideshare signup', {
    signupId,
    plan: data.plan,
    region: data.region,
    service: 'customer-99a8ba1a-rideshare',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const planInfo = lookupPlan(data.plan);
    if (!planInfo) {
      const err = new Error(`Unknown plan: ${data.plan}`);
      err.name = 'PlanNotFoundError';
      err.code = 'PLAN_NOT_FOUND';
      throw err;
    }

    const regionInfo = validateRegion(data.region);
    if (!regionInfo.valid) {
      const err = new Error(`Region unavailable: ${data.region}`);
      err.name = 'RegionUnavailableError';
      err.code = 'REGION_UNAVAILABLE';
      throw err;
    }

    const quotaInfo = getSignupQuota(data.plan);
    if (!quotaInfo || quotaInfo.allocation.remaining <= 0) {
      const err = new Error(`No signup slots available for plan: ${data.plan}`);
      err.name = 'QuotaExceededError';
      err.code = 'QUOTA_EXCEEDED';
      throw err;
    }

    const promoResult = applyPromoCode(data.promoCode, data.plan);
    const response = buildSignupResponse(planInfo, quotaInfo, regionInfo, promoResult);

    response.signupId = signupId;
    response.completedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('signup.success', {
      route: '/api/99a8ba1a/signup',
      plan: data.plan,
    });
    recordTiming('signup.latency', duration, {
      route: '/api/99a8ba1a/signup',
    });

    return { success: true, ...response };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('signup.failure', {
      route: '/api/99a8ba1a/signup',
      errorClass: error.name,
      plan: data.plan,
    });
    recordTiming('signup.latency', duration, {
      route: '/api/99a8ba1a/signup',
      error: 'true',
    });

    logger.error('Rideshare signup failed', {
      signupId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      plan: data.plan,
      region: data.region,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/99a8ba1a/signup',
        service: 'customer-99a8ba1a-rideshare',
        plan: data.plan,
      },
      extra: {
        signupId,
        plan: data.plan,
        region: data.region,
      },
    });

    createSessionAndAlert({
      customer: '99a8ba1a',
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/99a8ba1a.js \u2014 processSignup',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-99a8ba1a-rideshare',
      verticalLabel: 'Rideshare Signup Error',
      tags: [
        { key: 'route', value: '/api/99a8ba1a/signup' },
        { key: 'service', value: 'customer-99a8ba1a-rideshare' },
        { key: 'plan', value: data.plan },
      ],
      extra: { signupId, plan: data.plan, region: data.region },
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
      logger.error('Failed to trigger Devin session from signup error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processSignup, PLANS, REGIONS, SIGNUP_QUOTAS, PROMO_CODES, lookupPlan, getSignupQuota, validateRegion, applyPromoCode, buildSignupResponse };
