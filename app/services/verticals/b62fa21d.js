const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Rewards tier configuration
 */
const TIER_CONFIG = {
  platinum: { multiplier: 3.0, annualBonus: 500, minSpend: 5000 },
  gold:     { multiplier: 2.0, annualBonus: 250, minSpend: 2500 },
  silver:   { multiplier: 1.0, annualBonus: 100, minSpend: 1000 },
};

/**
 * Mock member database
 */
const MEMBERS = [
  { id: 'RL-10042891', email: 'alice.chen@example.com', name: 'Alice Chen', tier: 'platinum', points: 12450, lifetimeSpend: 28700.00 },
  { id: 'RL-10098234', email: 'james.wright@example.com', name: 'James Wright', tier: 'gold', points: 6820, lifetimeSpend: 14200.00 },
  { id: 'RL-10071562', email: 'sofia.martinez@example.com', name: 'Sofia Martinez', tier: 'silver', points: 2340, lifetimeSpend: 5100.00 },
  { id: 'RL-10055103', email: 'michael.park@example.com', name: 'Michael Park', tier: 'gold', points: 8910, lifetimeSpend: 19500.00 },
];

/**
 * Recent purchase history for display
 */
const RECENT_PURCHASES = [
  { date: '2026-04-10', item: 'Polo Bear Sweater', amount: 298.00, pointsEarned: 894 },
  { date: '2026-04-05', item: 'Slim Fit Oxford Shirt', amount: 125.00, pointsEarned: 375 },
  { date: '2026-03-28', item: 'Sullivan Slim Stretch Jean', amount: 168.00, pointsEarned: 504 },
  { date: '2026-03-15', item: 'Classic Fit Linen Shirt', amount: 148.00, pointsEarned: 444 },
];

/**
 * Look up a member record by email or member ID.
 * Returns the raw member data from the database.
 */
function findMember(query) {
  const member = MEMBERS.find(
    (m) => m.email === query.email || m.id === query.memberId
  );
  if (!member) return null;
  return {
    profile: {
      id: member.id,
      name: member.name,
      email: member.email,
      tier: member.tier,
    },
    rewards: {
      currentPoints: member.points,
      lifetimeSpend: member.lifetimeSpend,
    },
  };
}

/**
 * Resolve the tier benefits for a member's current tier.
 * Returns the benefits configuration with computed reward values.
 */
function resolveTierBenefits(memberData, requestedTier) {
  const tierKey = requestedTier || memberData.profile.tier;
  const config = TIER_CONFIG[tierKey];
  if (!config) return null;

  return {
    tier: tierKey,
    config,
  };
}

/**
 * Calculate the rewards balance from member data and tier benefits.
 * Converts points to dollar value based on tier multiplier.
 */
function calculateRewardsBalance(memberData, tierBenefits) {
  const pointsValue = memberData.rewards.currentPoints * 0.01;
  const tierMultiplier = tierBenefits.config.multiplier;
  const annualBonus = tierBenefits.config.annualBonus;

  const baseRewards = pointsValue * tierMultiplier;
  const totalRewards = baseRewards + annualBonus;

  return {
    points: memberData.rewards.currentPoints,
    pointsValue: pointsValue.toFixed(2),
    tierMultiplier,
    baseRewards: baseRewards.toFixed(2),
    annualBonus: annualBonus.toFixed(2),
    rewardsBalance: totalRewards.toFixed(2),
    nextTierSpend: calculateNextTierThreshold(memberData.rewards.lifetimeSpend, tierBenefits),
  };
}

/**
 * Determine how much more the member needs to spend to reach the next tier.
 */
function calculateNextTierThreshold(lifetimeSpend, tierBenefits) {
  const tiers = Object.entries(TIER_CONFIG)
    .sort((a, b) => a[1].minSpend - b[1].minSpend);
  const currentIdx = tiers.findIndex(([key]) => key === tierBenefits.tier);
  if (currentIdx >= tiers.length - 1) return { nextTier: null, amountNeeded: 0 };
  const nextTier = tiers[currentIdx + 1];
  return {
    nextTier: nextTier[0],
    amountNeeded: Math.max(0, nextTier[1].minSpend - lifetimeSpend),
  };
}

/**
 * Process a rewards balance lookup.
 */
async function processRewardsLookup(data) {
  const startTime = Date.now();
  const lookupId = uuidv4();

  logger.info('Processing rewards lookup', {
    lookupId,
    email: data.email,
    memberId: data.memberId,
    tier: data.tier,
    service: 'b62fa21d-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const memberData = findMember(data);
    if (!memberData) {
      const err = new Error('Member not found. Please verify your email and member ID.');
      err.name = 'MemberNotFoundError';
      err.code = 'MEMBER_NOT_FOUND';
      throw err;
    }

    const tierBenefits = resolveTierBenefits(memberData, data.tier);
    const balance = calculateRewardsBalance(memberData, tierBenefits);

    const duration = Date.now() - startTime;

    incrementMetric('rewards.lookup.success', {
      route: '/api/b62fa21d/rewards',
      tier: data.tier,
    });
    recordTiming('rewards.lookup.latency', duration, {
      route: '/api/b62fa21d/rewards',
    });

    return {
      success: true,
      lookupId,
      member: memberData.profile.name,
      tier: tierBenefits.tier,
      points: balance.points,
      rewardsBalance: balance.rewardsBalance,
      nextTier: balance.nextTierSpend,
      recentPurchases: RECENT_PURCHASES,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('rewards.lookup.failure', {
      route: '/api/b62fa21d/rewards',
      errorClass: error.name,
      tier: data.tier,
    });
    recordTiming('rewards.lookup.latency', duration, {
      route: '/api/b62fa21d/rewards',
      error: 'true',
    });

    logger.error('Rewards lookup failed', {
      lookupId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      email: data.email,
      memberId: data.memberId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/b62fa21d/rewards',
        service: 'b62fa21d-api',
        tier: data.tier,
      },
      extra: {
        lookupId,
        email: data.email,
        memberId: data.memberId,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b62fa21d.js — processRewardsLookup',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: 'b62fa21d-api',
      verticalLabel: 'Rewards Lookup',
      customer: 'b62fa21d',
      tags: [
        { key: 'route', value: '/api/b62fa21d/rewards' },
        { key: 'service', value: 'b62fa21d-api' },
        { key: 'tier', value: data.tier },
      ],
      extra: { lookupId, email: data.email, memberId: data.memberId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'b62fa21d@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from rewards lookup error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processRewardsLookup, MEMBERS, RECENT_PURCHASES };
