const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const REGIONS = [
  { code: 'us-west', name: 'San Francisco Bay Area', activeDrivers: 42800, avgWaitMin: 3.2 },
  { code: 'us-east', name: 'New York City', activeDrivers: 58200, avgWaitMin: 2.8 },
  { code: 'eu-west', name: 'London', activeDrivers: 31500, avgWaitMin: 4.1 },
  { code: 'ap-south', name: 'Mumbai', activeDrivers: 67300, avgWaitMin: 2.1 },
  { code: 'latam', name: 'São Paulo', activeDrivers: 45100, avgWaitMin: 3.7 },
];

const PLANS = [
  { id: 'rider', label: 'Uber Rider', monthlyCredits: 0, surgeCapPct: null, priorityPickup: false },
  { id: 'one-basic', label: 'Uber One Basic', monthlyCredits: 25, surgeCapPct: 15, priorityPickup: false },
  { id: 'one-premium', label: 'Uber One Premium', monthlyCredits: 75, surgeCapPct: 10, priorityPickup: true },
  { id: 'business', label: 'Uber for Business', monthlyCredits: 200, surgeCapPct: 5, priorityPickup: true },
];

const PROMO_CAMPAIGNS = {
  UBER2026: { discountPct: 20, maxRides: 5, expiresInDays: 30 },
  NEWRIDER: { discountPct: 50, maxRides: 3, expiresInDays: 14 },
  REFER50: { discountPct: 15, maxRides: 10, expiresInDays: 60 },
};

const SIGNUP_QUOTAS = {
  'us-west': { dailyCap: 5000, currentCount: 4812 },
  'us-east': { dailyCap: 8000, currentCount: 6230 },
  'eu-west': { dailyCap: 3000, currentCount: 2890 },
  'ap-south': { dailyCap: 10000, currentCount: 7450 },
  latam: { dailyCap: 6000, currentCount: 5100 },
};

function validateReferralCode(code) {
  if (!code) return null;
  const cleaned = code.trim().toUpperCase();
  const campaign = PROMO_CAMPAIGNS[cleaned];
  if (!campaign) return null;
  return {
    code: cleaned,
    ...campaign,
  };
}

function resolveRegion(regionCode) {
  return REGIONS.find((r) => r.code === regionCode);
}

function checkSignupCapacity(regionCode) {
  const quota = SIGNUP_QUOTAS[regionCode];
  if (!quota) return { allowed: true, remaining: Infinity };
  const remaining = quota.dailyCap - quota.currentCount;
  return {
    allowed: remaining > 0,
    remaining: Math.max(0, remaining),
    utilization: Math.round((quota.currentCount / quota.dailyCap) * 100),
  };
}

function computeOnboardingPackage(plan, region, promo) {
  const selectedPlan = PLANS.find((p) => p.id === plan);
  const regionData = resolveRegion(region);

  const driverAvailability = regionData.activeDrivers;
  const estimatedFirstRide = regionData.avgWaitMin;

  const packageDetails = {
    plan: selectedPlan.label,
    monthlyCredits: selectedPlan.monthlyCredits,
    estimatedPickupMin: estimatedFirstRide,
    nearbyDrivers: driverAvailability,
    surgeProtection: selectedPlan.surgeCapPct
      ? `Capped at ${selectedPlan.surgeCapPct}%`
      : 'None',
    priorityPickup: selectedPlan.priorityPickup,
  };

  if (promo) {
    packageDetails.promoApplied = promo.code;
    packageDetails.promoDiscount = `${promo.discountPct}% off first ${promo.maxRides} rides`;
    packageDetails.promoExpiry = `${promo.expiresInDays} days`;
  }

  const riderTier = selectedPlan.priorityPickup ? 'priority' : 'standard';
  const regionCapacity = checkSignupCapacity(region);
  const allocationScore = regionCapacity.utilization * driverAvailability;

  packageDetails.allocationTier = riderTier;
  packageDetails.regionScore = allocationScore;
  packageDetails.capacityRemaining = regionCapacity.onboarding.remaining;

  return packageDetails;
}

function buildSignupResponse(onboardingPkg, region, referralInfo) {
  const regionData = resolveRegion(region);
  const recommendations = [];

  if (onboardingPkg.nearbyDrivers > 50000) {
    recommendations.push('High driver availability — short wait times expected');
  }
  if (onboardingPkg.priorityPickup) {
    recommendations.push('Priority pickup enabled — you\'ll be matched first');
  }
  if (referralInfo) {
    recommendations.push(`Promo ${referralInfo.code} applied — ${referralInfo.discountPct}% off`);
  }

  return {
    region: regionData.name,
    regionCode: region,
    plan: onboardingPkg.plan,
    estimatedPickup: `${onboardingPkg.estimatedPickupMin} min`,
    nearbyDrivers: onboardingPkg.nearbyDrivers,
    recommendations,
    package: onboardingPkg,
  };
}

async function processSignup(data) {
  const startTime = Date.now();
  const signupId = uuidv4();

  logger.info('Processing rider signup', {
    signupId,
    plan: data.plan,
    region: data.region,
    referralCode: data.referralCode,
    service: 'customer-99a8ba1a-rideshare',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const promo = validateReferralCode(data.referralCode);
    const onboardingPkg = computeOnboardingPackage(data.plan, data.region, promo);
    const response = buildSignupResponse(onboardingPkg, data.region, promo);

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

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('signup.failure', {
      route: '/api/99a8ba1a/signup',
      errorClass: error.name,
    });
    recordTiming('signup.latency', duration, {
      route: '/api/99a8ba1a/signup',
      error: 'true',
    });

    logger.error('Rider signup failed', {
      signupId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      plan: data.plan,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/99a8ba1a/signup',
        service: 'customer-99a8ba1a-rideshare',
        plan: data.plan,
      },
      extra: { signupId, plan: data.plan, region: data.region },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/99a8ba1a.js \u2014 processSignup',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-99a8ba1a-rideshare',
      verticalLabel: 'Rider Signup',
      customer: '99a8ba1a',
      slackMemberId: 'U08S7AVJ478',
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
      release: process.env.SENTRY_RELEASE || 'customer-99a8ba1a-rideshare@2.1.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for signup error', {
        error: err.message,
        signupId,
      });
    });

    throw error;
  }
}

module.exports = { processSignup, REGIONS, PLANS };
