const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Loyalty rewards tier configuration.
 *
 * Each tier has a `config` object with `multiplier` (points earning rate)
 * and `annualBonus` (yearly bonus points).
 *
 * BUG (now fixed): The "platinum" tier was missing the nested `config`
 * wrapper — its `multiplier` and `annualBonus` properties sat directly
 * on the tier object instead of under `config`.  This caused:
 *   TypeError: Cannot read properties of undefined (reading 'multiplier')
 * in calculateRewardsBalance() when a platinum-tier member looked up
 * their rewards.
 */
const TIER_BENEFITS = {
  bronze: {
    label: 'Bronze',
    config: { multiplier: 1.0, annualBonus: 100 },
  },
  silver: {
    label: 'Silver',
    config: { multiplier: 1.5, annualBonus: 250 },
  },
  gold: {
    label: 'Gold',
    config: { multiplier: 2.0, annualBonus: 500 },
  },
  platinum: {
    label: 'Platinum',
    config: { multiplier: 3.0, annualBonus: 1000 },
  },
};

/**
 * Rewards member database.
 */
const MEMBERS = [
  {
    id: 'RL-10042891',
    name: 'Alice Chen',
    email: 'alice.chen@example.com',
    tier: 'platinum',
    rewards: { currentPoints: 24500, lifetimePoints: 87200 },
    memberSince: '2022-03-15',
  },
  {
    id: 'RL-10038472',
    name: 'James Wilson',
    email: 'james.wilson@example.com',
    tier: 'gold',
    rewards: { currentPoints: 12300, lifetimePoints: 45600 },
    memberSince: '2023-01-10',
  },
  {
    id: 'RL-10051903',
    name: 'Maria Santos',
    email: 'maria.santos@example.com',
    tier: 'silver',
    rewards: { currentPoints: 5800, lifetimePoints: 18200 },
    memberSince: '2024-06-22',
  },
  {
    id: 'RL-10060217',
    name: 'Robert Kim',
    email: 'robert.kim@example.com',
    tier: 'bronze',
    rewards: { currentPoints: 1200, lifetimePoints: 3400 },
    memberSince: '2025-11-05',
  },
];

/**
 * Calculate the rewards balance for a member given their tier benefits.
 */
function calculateRewardsBalance(memberData, tierBenefits) {
  const pointsValue = memberData.rewards.currentPoints * 0.01;
  const tierMultiplier = tierBenefits.config.multiplier;
  const annualBonus = tierBenefits.config.annualBonus;

  const baseRewards = pointsValue * tierMultiplier;
  const totalValue = baseRewards + (annualBonus * 0.01);

  return {
    currentPoints: memberData.rewards.currentPoints,
    lifetimePoints: memberData.rewards.lifetimePoints,
    pointsValue: Math.round(baseRewards * 100) / 100,
    totalValue: Math.round(totalValue * 100) / 100,
    tierMultiplier,
    annualBonus,
  };
}

/**
 * Look up a member by email address.
 */
function lookupMember(email) {
  const member = MEMBERS.find(
    (m) => m.email.toLowerCase() === email.toLowerCase(),
  );
  if (!member) {
    const err = new Error(`No rewards member found for email: ${email}`);
    err.code = 'MEMBER_NOT_FOUND';
    throw err;
  }
  return member;
}

/**
 * Resolve tier benefits for a member's tier level.
 */
function resolveTierBenefits(tier) {
  return TIER_BENEFITS[tier] || TIER_BENEFITS.bronze;
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
    service: 'b62fa21d-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 80));

    const memberData = lookupMember(data.email);
    const tierBenefits = resolveTierBenefits(memberData.tier);
    const balance = calculateRewardsBalance(memberData, tierBenefits);

    const duration = Date.now() - startTime;

    incrementMetric('rewards.lookup.success', {
      route: '/api/b62fa21d/rewards',
      tier: memberData.tier,
    });
    recordTiming('rewards.lookup.latency', duration, {
      route: '/api/b62fa21d/rewards',
    });

    return {
      success: true,
      lookupId,
      memberId: memberData.id,
      memberName: memberData.name,
      tier: memberData.tier,
      tierLabel: tierBenefits.label,
      balance,
      memberSince: memberData.memberSince,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('rewards.lookup.failure', {
      route: '/api/b62fa21d/rewards',
      errorClass: error.name,
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
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/b62fa21d/rewards',
        service: 'b62fa21d-api',
        tier: data.tier || 'unknown',
      },
      extra: {
        lookupId,
        email: data.email,
        memberId: data.memberId,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b62fa21d.js \u2014 processRewardsLookup',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      service: 'b62fa21d-api',
      verticalLabel: 'Loyalty Rewards Lookup',
      customer: data.customer || 'acme-demo',
      tags: [
        { key: 'route', value: '/api/b62fa21d/rewards' },
        { key: 'service', value: 'b62fa21d-api' },
        { key: 'tier', value: data.tier || 'unknown' },
      ],
      extra: { lookupId, email: data.email },
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
      logger.error('Failed to trigger Devin session from rewards lookup error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processRewardsLookup, MEMBERS, TIER_BENEFITS };
