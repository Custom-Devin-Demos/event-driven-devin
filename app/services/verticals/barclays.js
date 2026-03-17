const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Credit card products available for rewards lookup
 */
const CARD_PRODUCTS = [
  { id: 'visa-signature', name: 'Visa Signature', baseRate: 2.0, bonusCategories: ['dining', 'travel'], annualFee: 0 },
  { id: 'world-elite', name: 'World Elite Mastercard', baseRate: 1.5, bonusCategories: ['groceries', 'gas'], annualFee: 95 },
  { id: 'rewards-plus', name: 'Barclays Rewards+', baseRate: 2.0, bonusCategories: ['online', 'streaming'], annualFee: 0 },
  { id: 'aadvantage', name: 'AAdvantage Aviator', baseRate: 1.0, bonusCategories: ['airlines', 'hotels'], annualFee: 99 },
];

/**
 * Rewards tier multipliers
 */
const TIER_MULTIPLIERS = [
  { tier: 'platinum', rates: { multiplier: 2.5, bonus: 1.2 }, minSpend: 5000 },
  { tier: 'gold', rates: { multiplier: 2.0, bonus: 1.0 }, minSpend: 2500 },
  { tier: 'silver', rates: { multiplier: 1.5, bonus: 0.8 }, minSpend: 1000 },
  { tier: 'standard', rates: { multiplier: 1.0, bonus: 0.5 }, minSpend: 0 },
];

/**
 * Recent reward transactions for display
 */
const RECENT_REWARDS = [
  { id: 'RWD-001', date: '2026-03-15', description: 'Dining — Olive Garden', points: 450, category: 'dining' },
  { id: 'RWD-002', date: '2026-03-14', description: 'Travel — Delta Airlines', points: 1200, category: 'travel' },
  { id: 'RWD-003', date: '2026-03-12', description: 'Groceries — Whole Foods', points: 320, category: 'groceries' },
  { id: 'RWD-004', date: '2026-03-10', description: 'Gas — Shell Station', points: 180, category: 'gas' },
  { id: 'RWD-005', date: '2026-03-08', description: 'Online — Amazon.com', points: 560, category: 'online' },
];

/**
 * Look up the card product details.
 */
function getCardProduct(cardType) {
  return CARD_PRODUCTS.find((card) => card.id === cardType);
}

/**
 * Fetch the rewards tier configuration for the given tier.
 * Simulates a remote service call to the rewards platform.
 */
async function fetchTierConfig(tierName) {
  await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 60));
  const config = TIER_MULTIPLIERS.find((t) => t.tier === tierName);
  return config;
}

/**
 * Calculate the points earned for a given spend and rate.
 */
function calculatePoints(spend, baseRate, multiplier) {
  const rawPoints = Math.floor(spend * baseRate * multiplier);
  return rawPoints;
}

/**
 * Convert points to a cashback dollar value.
 */
function pointsToCashback(points, conversionRate) {
  return (points * conversionRate).toFixed(2);
}

/**
 * Format the rewards summary for the API response.
 */
function formatRewardsSummary(card, tierConfig, points, cashback) {
  return {
    cardName: card.name,
    tier: tierConfig.tier,
    pointsEarned: points,
    cashbackValue: cashback,
    bonusCategories: card.bonusCategories,
    nextTierSpend: tierConfig.minSpend,
    annualFee: card.annualFee,
  };
}

/**
 * Process a rewards check for a given card and spending period.
 */
async function processRewardsCheck(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing rewards check', {
    requestId,
    cardType: data.cardType,
    rewardsTier: data.rewardsTier,
    monthlySpend: data.monthlySpend,
    service: 'barclays-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const card = getCardProduct(data.cardType);
    const tierConfig = await fetchTierConfig(data.rewardsTier);

    const points = calculatePoints(data.monthlySpend, card.baseRate, tierConfig.rates.multiplier);
    const cashback = pointsToCashback(points, 0.01);
    const summary = formatRewardsSummary(card, tierConfig, points, cashback);

    const duration = Date.now() - startTime;

    incrementMetric('rewards.check.success', {
      route: '/api/barclays/rewards',
      cardType: data.cardType,
    });
    recordTiming('rewards.check.latency', duration, {
      route: '/api/barclays/rewards',
    });

    return {
      success: true,
      requestId,
      ...summary,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('rewards.check.failure', {
      route: '/api/barclays/rewards',
      errorClass: error.name,
      cardType: data.cardType,
    });
    recordTiming('rewards.check.latency', duration, {
      route: '/api/barclays/rewards',
      error: 'true',
    });

    logger.error('Rewards check failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      cardType: data.cardType,
      rewardsTier: data.rewardsTier,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/barclays/rewards',
        service: 'barclays-api',
        cardType: data.cardType,
      },
      extra: {
        requestId,
        cardType: data.cardType,
        monthlySpend: data.monthlySpend,
        rewardsTier: data.rewardsTier,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/barclays.js — processRewardsCheck',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'barclays-api',
      verticalLabel: 'Barclays Rewards Check',
      tags: [
        { key: 'route', value: '/api/barclays/rewards' },
        { key: 'service', value: 'barclays-api' },
        { key: 'cardType', value: data.cardType },
      ],
      extra: { requestId, cardType: data.cardType, monthlySpend: data.monthlySpend, rewardsTier: data.rewardsTier },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'barclays@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from rewards error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processRewardsCheck, CARD_PRODUCTS, RECENT_REWARDS };
