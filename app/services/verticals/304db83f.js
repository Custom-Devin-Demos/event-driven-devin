const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const PLAN_CATALOG = {
  essential: { name: 'Essential', price: 8.99, features: ['ad-supported', '40000+ episodes', 'live-tv'] },
  premium: { name: 'Premium', price: 13.99, features: ['ad-free', 'showtime', 'downloads', 'live-cbs', '4k-uhd'] },
};

const SUBSCRIBERS = [
  { id: 'PP-90281734', email: 'marcus.reeves@example.com', name: 'Marcus Reeves', plan: 'premium', status: 'active', billingCycle: 'monthly', nextBilling: '2026-05-15', profileCount: 4 },
  { id: 'PP-90384521', email: 'diana.liu@example.com', name: 'Diana Liu', plan: 'essential', status: 'active', billingCycle: 'annual', nextBilling: '2027-01-08', profileCount: 2 },
  { id: 'PP-90156892', email: 'kevin.omalley@example.com', name: "Kevin O'Malley", plan: 'premium', status: 'suspended', billingCycle: 'monthly', nextBilling: null, profileCount: 3 },
  { id: 'PP-90423167', email: 'sarah.tanaka@example.com', name: 'Sarah Tanaka', plan: 'essential', status: 'active', billingCycle: 'monthly', nextBilling: '2026-05-02', profileCount: 1 },
];

const WATCH_HISTORY = [
  { title: 'Landman', season: 1, episode: 8, progress: 0.72, lastWatched: '2026-04-22' },
  { title: 'Lioness', season: 2, episode: 3, progress: 1.0, lastWatched: '2026-04-20' },
  { title: '1923', season: 2, episode: 5, progress: 0.45, lastWatched: '2026-04-18' },
  { title: 'Mayor of Kingstown', season: 3, episode: 1, progress: 0.10, lastWatched: '2026-04-15' },
];

const PROMO_CODES = {
  STREAM30: { discountPct: 30, validUntil: '2026-06-30', minPlan: 'essential', appliesTo: ['monthly'] },
  PREMIUM50: { discountPct: 50, validUntil: '2026-05-31', minPlan: 'premium', appliesTo: ['monthly', 'annual'] },
  FREETRIAL: { discountPct: 100, validUntil: '2026-12-31', minPlan: 'essential', appliesTo: ['monthly'] },
};

function lookupSubscriber(query) {
  const subscriber = SUBSCRIBERS.find(
    (s) => s.email === query.email || s.id === query.subscriberId
  );
  if (!subscriber) return null;
  return {
    account: {
      id: subscriber.id,
      name: subscriber.name,
      email: subscriber.email,
      plan: subscriber.plan,
      status: subscriber.status,
    },
    billing: {
      cycle: subscriber.billingCycle,
      nextDate: subscriber.nextBilling,
      profiles: subscriber.profileCount,
    },
  };
}

function resolveSubscriptionDetails(subscriberData) {
  const planKey = subscriberData.account.plan;
  const planInfo = PLAN_CATALOG[planKey];
  if (!planInfo) return null;

  return {
    planName: planInfo.name,
    monthlyRate: planInfo.price,
    featureList: planInfo.features,
    billing: subscriberData.billing,
  };
}

function calculateAccountSummary(subscriberData, subscriptionDetails) {
  const annualCost = subscriptionDetails.details.monthlyRate * 12;
  const profileAllowance = subscriptionDetails.details.featureList.includes('downloads') ? 6 : 3;
  const remainingProfiles = profileAllowance - subscriberData.billing.profiles;

  const watchStats = WATCH_HISTORY.reduce((acc, item) => {
    acc.totalShows += 1;
    acc.completedEpisodes += item.progress >= 1.0 ? 1 : 0;
    acc.inProgress += item.progress > 0 && item.progress < 1.0 ? 1 : 0;
    return acc;
  }, { totalShows: 0, completedEpisodes: 0, inProgress: 0 });

  return {
    subscriber: subscriberData.account.name,
    plan: subscriptionDetails.details.planName,
    monthlyRate: subscriptionDetails.details.monthlyRate,
    annualProjection: annualCost.toFixed(2),
    features: subscriptionDetails.details.featureList,
    profilesUsed: subscriberData.billing.profiles,
    profilesAvailable: remainingProfiles,
    nextBillingDate: subscriberData.billing.nextDate,
    watchActivity: watchStats,
    recentlyWatched: WATCH_HISTORY.slice(0, 3).map((w) => ({
      title: w.title,
      progress: Math.round(w.progress * 100) + '%',
    })),
  };
}

function applyPromoValidation(summary, promoCode) {
  if (!promoCode) return { promo: null };
  const promo = PROMO_CODES[promoCode.toUpperCase()];
  if (!promo) return { promo: null, promoError: 'Invalid promo code' };

  const now = new Date();
  const expiry = new Date(promo.validUntil);
  if (now > expiry) return { promo: null, promoError: 'Promo code expired' };

  const discountedRate = summary.monthlyRate * (1 - promo.discountPct / 100);
  return {
    promo: {
      code: promoCode.toUpperCase(),
      discount: promo.discountPct + '%',
      newMonthlyRate: discountedRate.toFixed(2),
      validUntil: promo.validUntil,
    },
  };
}

async function processAccountLookup(data) {
  const startTime = Date.now();
  const lookupId = uuidv4();

  logger.info('Processing account lookup', {
    lookupId,
    email: data.email,
    subscriberId: data.subscriberId,
    service: '304db83f-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const subscriberData = lookupSubscriber(data);
    if (!subscriberData) {
      const err = new Error('Account not found. Please verify your email and subscriber ID.');
      err.name = 'AccountNotFoundError';
      err.code = 'ACCOUNT_NOT_FOUND';
      throw err;
    }

    const subscriptionDetails = resolveSubscriptionDetails(subscriberData);
    const summary = calculateAccountSummary(subscriberData, subscriptionDetails);
    const promoResult = applyPromoValidation(summary, data.promoCode);

    const duration = Date.now() - startTime;

    incrementMetric('account.lookup.success', {
      route: '/api/304db83f/account',
      plan: subscriberData.account.plan,
    });
    recordTiming('account.lookup.latency', duration, {
      route: '/api/304db83f/account',
    });

    return {
      success: true,
      lookupId,
      ...summary,
      ...promoResult,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('account.lookup.failure', {
      route: '/api/304db83f/account',
      errorClass: error.name,
    });
    recordTiming('account.lookup.latency', duration, {
      route: '/api/304db83f/account',
      error: 'true',
    });

    logger.error('Account lookup failed', {
      lookupId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      email: data.email,
      subscriberId: data.subscriberId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/304db83f/account',
        service: '304db83f-api',
        plan: data.plan,
      },
      extra: {
        lookupId,
        email: data.email,
        subscriberId: data.subscriberId,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/304db83f.js — processAccountLookup',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: '304db83f-api',
      verticalLabel: 'Account Lookup',
      customer: '304db83f',
      tags: [
        { key: 'route', value: '/api/304db83f/account' },
        { key: 'service', value: '304db83f-api' },
        { key: 'plan', value: data.plan || 'unknown' },
      ],
      extra: { lookupId, email: data.email, subscriberId: data.subscriberId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '304db83f@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from account lookup error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processAccountLookup, SUBSCRIBERS, PLAN_CATALOG };
