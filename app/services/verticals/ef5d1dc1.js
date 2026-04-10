const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Rewards tier thresholds
 */
const TIER_THRESHOLDS = [
  { level: 'gold', minimum: 1000, multiplier: 2.0 },
  { level: 'silver', minimum: 500, multiplier: 1.5 },
  { level: 'bronze', minimum: 0, multiplier: 1.0 },
];

/**
 * Registered rewards members
 */
const MEMBERS = [
  { id: 'ZAX-4001', name: 'Marcus Johnson', phone: '(555) 867-5309', totalEarned: 1475, totalSpent: 320, pendingPoints: 85, homeStore: 'athens-ga' },
  { id: 'ZAX-4002', name: 'Sarah Chen', phone: '(555) 234-5678', totalEarned: 620, totalSpent: 110, pendingPoints: 45, homeStore: 'atlanta-ga' },
  { id: 'ZAX-4003', name: 'David Williams', phone: '(555) 345-6789', totalEarned: 280, totalSpent: 50, pendingPoints: 30, homeStore: 'dallas-tx' },
  { id: 'ZAX-4004', name: 'Emily Rodriguez', phone: '(555) 456-7890', totalEarned: 950, totalSpent: 200, pendingPoints: 60, homeStore: 'nashville-tn' },
];

/**
 * Visit history for point aggregation
 */
const VISIT_HISTORY = {
  'ZAX-4001': [
    { date: '2026-03-15', store: 'athens-ga', items: [{ menuId: 'CF-5', qty: 1, points: 150 }, { menuId: 'DR-2', qty: 2, points: 40 }] },
    { date: '2026-03-10', store: 'athens-ga', items: [{ menuId: 'WG-3', qty: 1, points: 120 }, { menuId: 'SD-1', qty: 1, points: 30 }] },
    { date: '2026-03-05', store: 'atlanta-ga', items: [{ menuId: 'CF-5', qty: 2, points: 300 }, { menuId: 'TR-1', qty: 1, points: 50 }] },
  ],
  'ZAX-4002': [
    { date: '2026-03-14', store: 'atlanta-ga', items: [{ menuId: 'SM-2', qty: 1, points: 130 }, { menuId: 'DR-3', qty: 1, points: 25 }] },
    { date: '2026-03-08', store: 'atlanta-ga', items: [{ menuId: 'ZL-1', qty: 1, points: 110 }] },
  ],
  'ZAX-4003': [
    { date: '2026-03-12', store: 'dallas-tx', items: [{ menuId: 'CF-5', qty: 1, points: 150 }] },
  ],
  'ZAX-4004': [
    { date: '2026-03-13', store: 'nashville-tn', items: [{ menuId: 'WG-3', qty: 2, points: 240 }, { menuId: 'SD-1', qty: 2, points: 60 }] },
    { date: '2026-03-07', store: 'nashville-tn', items: [{ menuId: 'SM-2', qty: 1, points: 130 }] },
  ],
};

/**
 * Look up a rewards member by phone number.
 */
function lookupMember(phone) {
  const normalized = phone.replace(/\D/g, '').slice(-10);
  const member = MEMBERS.find(m => m.phone.replace(/\D/g, '').slice(-10) === normalized);
  if (!member) {
    const err = new Error(`No rewards account found for phone: ${phone}`);
    err.code = 'MEMBER_NOT_FOUND';
    throw err;
  }
  return member;
}

/**
 * Aggregate points from visit history for a member.
 */
async function fetchRewardsBalance(memberId) {
  await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 60));
  const visits = VISIT_HISTORY[memberId] || [];
  let earned = 0;
  for (const visit of visits) {
    for (const item of visit.items) {
      earned += item.points * item.qty;
    }
  }
  const member = MEMBERS.find(m => m.id === memberId);
  const redeemed = member ? member.totalSpent : 0;
  return { earned, redeemed, pending: member ? member.pendingPoints : 0 };
}

/**
 * Determine the rewards tier based on net points.
 */
function computeTierStatus(memberId) {
  const balance = fetchRewardsBalance(memberId);
  const netPoints = balance.earned - balance.redeemed;
  const tier = TIER_THRESHOLDS.find(t => netPoints >= t.minimum);
  return { name: tier.name, points: netPoints, bonus: tier.multiplier };
}

/**
 * Format the rewards lookup response for the client.
 */
function formatRewardsSummary(memberInfo, tierStatus) {
  return {
    memberName: memberInfo.name,
    memberId: memberInfo.id,
    currentTier: tierStatus.tier,
    totalPoints: tierStatus.points,
    bonusMultiplier: tierStatus.bonus,
    homeStore: memberInfo.homeStore,
  };
}

/**
 * Process a rewards balance lookup.
 */
async function processRewardsLookup(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing rewards lookup', {
    requestId,
    phone: data.phone,
    location: data.location,
    service: 'customer-ef5d1dc1-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const member = lookupMember(data.phone);
    const tierStatus = computeTierStatus(member.id);
    const summary = formatRewardsSummary(member, tierStatus);

    const duration = Date.now() - startTime;

    incrementMetric('rewards.lookup.success', {
      route: '/api/ef5d1dc1/rewards',
      location: data.location,
    });
    recordTiming('rewards.lookup.latency', duration, {
      route: '/api/ef5d1dc1/rewards',
    });

    return {
      success: true,
      requestId,
      ...summary,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('rewards.lookup.failure', {
      route: '/api/ef5d1dc1/rewards',
      errorClass: error.name,
      location: data.location,
    });
    recordTiming('rewards.lookup.latency', duration, {
      route: '/api/ef5d1dc1/rewards',
      error: 'true',
    });

    logger.error('Rewards lookup failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      phone: data.phone,
      location: data.location,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/ef5d1dc1/rewards',
        service: 'customer-ef5d1dc1-api',
        location: data.location,
      },
      extra: {
        requestId,
        phone: data.phone,
        location: data.location,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ef5d1dc1.js — processRewardsLookup',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      service: 'customer-ef5d1dc1-api',
      verticalLabel: 'Zaxby\'s Rewards Lookup',
      customer: 'ef5d1dc1',
      tags: [
        { key: 'route', value: '/api/ef5d1dc1/rewards' },
        { key: 'service', value: 'customer-ef5d1dc1-api' },
        { key: 'location', value: data.location },
      ],
      extra: { requestId, phone: data.phone, location: data.location },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'zaxbys@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from rewards lookup error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processRewardsLookup, MEMBERS, TIER_THRESHOLDS };
