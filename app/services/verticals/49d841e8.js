const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Customer accounts for the dashboard display
 */
const ACCOUNTS = [
  { id: 'NUCONTA-8841', name: 'NuConta', type: 'checking', balance: 4820.35, currency: 'BRL' },
  { id: 'CARTAO-2290', name: 'Cartão de Crédito', type: 'credit', balance: -1342.18, limit: 12000.00, currency: 'BRL' },
  { id: 'CAIXINHA-1174', name: 'Caixinha Reserva', type: 'savings', balance: 15750.00, currency: 'BRL' },
];

/**
 * Recent card transactions eligible for cashback
 */
const TRANSACTIONS = [
  { id: 'TXN-9001', date: '2026-07-20', description: 'iFood', amount: 68.90, category: 'dining', account: 'CARTAO-2290' },
  { id: 'TXN-9002', date: '2026-07-19', description: 'Uber', amount: 24.50, category: 'transport', account: 'CARTAO-2290' },
  { id: 'TXN-9003', date: '2026-07-18', description: 'Amazon Brasil', amount: 312.99, category: 'shopping', account: 'CARTAO-2290' },
  { id: 'TXN-9004', date: '2026-07-17', description: 'Posto Ipiranga', amount: 180.00, category: 'fuel', account: 'CARTAO-2290' },
  { id: 'TXN-9005', date: '2026-07-15', description: 'Assinatura Netflix', amount: 44.90, category: 'subscription', account: 'CARTAO-2290' },
];

/**
 * Rewards program tiers keyed by card product.
 */
const REWARD_TIERS = {
  standard:     { cashbackRate: 0.005, pointsMultiplier: 1,   monthlyCap: 50.00 },
  ultravioleta: { cashbackRate: 0.01,  pointsMultiplier: 2,   monthlyCap: 500.00 },
  pj:           { cashbackRate: 0.008, pointsMultiplier: 1.5, monthlyCap: 300.00 },
};

/**
 * Resolve the rewards configuration for a given card product.
 */
async function resolveRewardTier(cardProduct) {
  const tier = REWARD_TIERS[cardProduct];
  if (!tier) return null;
  return { params: [tier.cashbackRate, tier.pointsMultiplier, tier.monthlyCap] };
}

/**
 * Compute the cashback earned from the resolved tier configuration.
 */
function computeCashback(tierData, amount) {
  const gross = tierData.rewards.cashbackRate * amount;
  const cap = tierData.rewards.monthlyCap;
  return Math.min(gross, cap);
}

/**
 * Format a redemption receipt for the response.
 */
function formatRedemption(redemption, cashbackBreakdown) {
  return {
    receiptId: `RDM-${Date.now()}`,
    account: redemption.account,
    eligibleSpend: redemption.amount.toFixed(2),
    cashback: cashbackBreakdown.cashback.toFixed(2),
    points: cashbackBreakdown.points,
    currency: 'BRL',
    timestamp: new Date().toISOString(),
  };
}

/**
 * Process a rewards cashback redemption for a card product.
 */
async function processRedemption(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing rewards redemption', {
    requestId,
    account: data.account,
    cardProduct: data.cardProduct,
    amount: data.amount,
    service: '49d841e8-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const tierData = resolveRewardTier(data.cardProduct);
    const cashback = computeCashback(tierData, data.amount);
    const points = Math.round(data.amount * REWARD_TIERS[data.cardProduct].pointsMultiplier);
    const receipt = formatRedemption(data, { cashback, points });

    const duration = Date.now() - startTime;

    incrementMetric('redemption.success', {
      route: '/api/49d841e8/redeem',
      cardProduct: data.cardProduct,
    });
    recordTiming('redemption.latency', duration, {
      route: '/api/49d841e8/redeem',
    });

    return {
      success: true,
      requestId,
      receipt,
      status: 'completed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('redemption.failure', {
      route: '/api/49d841e8/redeem',
      errorClass: error.name,
      cardProduct: data.cardProduct,
    });
    recordTiming('redemption.latency', duration, {
      route: '/api/49d841e8/redeem',
      error: 'true',
    });

    logger.error('Redemption failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      account: data.account,
      cardProduct: data.cardProduct,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/49d841e8/redeem',
        service: '49d841e8-api',
        cardProduct: data.cardProduct,
      },
      extra: {
        requestId,
        account: data.account,
        cardProduct: data.cardProduct,
        amount: data.amount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/49d841e8.js — processRedemption',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: '49d841e8-api',
      verticalLabel: 'Rewards Cashback',
      customer: '49d841e8',
      tags: [
        { key: 'route', value: '/api/49d841e8/redeem' },
        { key: 'service', value: '49d841e8-api' },
        { key: 'cardProduct', value: data.cardProduct },
      ],
      extra: { requestId, account: data.account, cardProduct: data.cardProduct, amount: data.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-49d841e8@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from redemption error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processRedemption, ACCOUNTS, TRANSACTIONS, REWARD_TIERS };
