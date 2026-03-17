const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Portfolio holdings for the demo
 */
const PORTFOLIO = [
  { symbol: 'AAPL', name: 'Apple Inc.', shares: 150, avgCost: 178.25, currentPrice: 227.63 },
  { symbol: 'MSFT', name: 'Microsoft Corp.', shares: 80, avgCost: 345.10, currentPrice: 412.88 },
  { symbol: 'GOOGL', name: 'Alphabet Inc.', shares: 45, avgCost: 138.50, currentPrice: 174.22 },
  { symbol: 'AMZN', name: 'Amazon.com Inc.', shares: 60, avgCost: 155.80, currentPrice: 198.45 },
  { symbol: 'NVDA', name: 'NVIDIA Corp.', shares: 100, avgCost: 480.00, currentPrice: 892.30 },
  { symbol: 'JPM', name: 'JPMorgan Chase', shares: 120, avgCost: 172.40, currentPrice: 198.76 },
];

/**
 * Commission tier schedule
 */
const COMMISSION_TIERS = new Map([
  [1, { rate: 0.0050, label: 'Standard', minFee: 4.95 }],
  [2, { rate: 0.0035, label: 'Active Trader', minFee: 2.95 }],
  [3, { rate: 0.0010, label: 'VIP', minFee: 0.00 }],
]);

/**
 * Look up the commission tier for a given tier ID.
 */
function getCommissionRate(tierId) {
  const numericId = Number(tierId);
  const tier = COMMISSION_TIERS.get(numericId);
  if (!tier) {
    throw new Error(`Unknown commission tier: ${tierId}`);
  }
  return tier;
}

/**
 * Execute a trade order.
 */
async function executeTrade(tradeData) {
  const startTime = Date.now();
  const tradeId = uuidv4();

  logger.info('Executing trade', {
    tradeId,
    symbol: tradeData.symbol,
    side: tradeData.side,
    quantity: tradeData.quantity,
    service: 'trading-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 140));

    const commission = getCommissionRate(tradeData.tierId);
    const tradeValue = tradeData.quantity * tradeData.price;
    const fee = Math.max(tradeValue * commission.rate, commission.minFee);
    const totalCost = tradeData.side === 'buy' ? tradeValue + fee : tradeValue - fee;

    const duration = Date.now() - startTime;

    incrementMetric('trade.success', {
      route: '/api/trading/execute',
      side: tradeData.side,
    });
    recordTiming('trade.latency', duration, {
      route: '/api/trading/execute',
    });

    return {
      success: true,
      tradeId,
      symbol: tradeData.symbol,
      side: tradeData.side,
      quantity: tradeData.quantity,
      price: tradeData.price,
      fee: Math.round(fee * 100) / 100,
      total: Math.round(totalCost * 100) / 100,
      status: 'filled',
      filledAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('trade.failure', {
      route: '/api/trading/execute',
      errorClass: error.name,
    });
    recordTiming('trade.latency', duration, {
      route: '/api/trading/execute',
      error: 'true',
    });

    logger.error('Trade execution failed', {
      tradeId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      symbol: tradeData.symbol,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/trading/execute',
        service: 'trading-api',
        side: tradeData.side,
      },
      extra: { tradeId, symbol: tradeData.symbol, quantity: tradeData.quantity },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/financial-services.js — executeTrade',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: 'trading-api',
      verticalLabel: 'Trade Execution',
      tags: [
        { key: 'route', value: '/api/trading/execute' },
        { key: 'service', value: 'trading-api' },
      ],
      extra: { tradeId, symbol: tradeData.symbol, quantity: tradeData.quantity },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'meridian-capital@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from trade error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { executeTrade, PORTFOLIO, COMMISSION_TIERS };
