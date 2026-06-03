const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Visa Acceptance — line-item catalog for a card-present/card-not-present
 * authorization. Each entry is something the cardholder is paying for,
 * priced in the transaction's presentment currency.
 */
const CATALOG = [
  { id: 'TKT-WC26-FINAL', name: 'FIFA World Cup 2026\u2122 Final \u2014 Category 1', price: 950.00, category: 'tickets' },
  { id: 'TRV-FLIGHT-JFK', name: 'Round-Trip Flight \u2014 JFK \u2192 MEX', price: 612.40, category: 'travel' },
  { id: 'HTL-3NIGHTS', name: 'Hotel \u2014 3 Nights, Downtown', price: 528.00, category: 'travel' },
  { id: 'DIN-CONCIERGE', name: 'Visa Signature\u00AE Concierge Dining', price: 240.00, category: 'dining' },
  { id: 'INS-TRIP', name: 'Trip Cancellation Protection', price: 49.00, category: 'protection' },
  { id: 'FX-MARKUP', name: 'Cross-Border Service Fee', price: 12.50, category: 'fees' },
];

/**
 * Settlement region configuration — network assessment + presentment currency.
 */
const SETTLEMENT_REGIONS = {
  US: { assessmentRate: 0.0014, currency: 'USD' },
  EU: { assessmentRate: 0.0010, currency: 'EUR' },
  UK: { assessmentRate: 0.0010, currency: 'GBP' },
  MX: { assessmentRate: 0.0014, currency: 'MXN' },
};

/**
 * Active rewards — "Visa Signature\u00AE Cashback" applied at authorization
 * so it appears as a credit line on the settlement statement.
 */
const ACTIVE_REWARDS = [
  { sku: 'VISA-CASHBACK-2026', name: 'Visa Signature\u00AE Cashback Credit', price: -25.00, qty: 1 },
];

/**
 * Returns the cardholder benefit tier for a given authorization amount.
 */
function getBenefitTier(amount) {
  if (amount >= 2000) return { rate: 0.02, label: 'Infinite \u2014 2% cashback' };
  if (amount >= 1000) return { rate: 0.015, label: 'Signature \u2014 1.5% cashback' };
  return { rate: 0.01, label: 'Classic \u2014 1% cashback' };
}

/**
 * Merges Visa reward credits into the authorization line items.
 */
function applyRewards(items) {
  return [...items, ...ACTIVE_REWARDS];
}

/**
 * Computes the final settlement amount for the authorization.
 */
function computeSettlement(amount, region) {
  const regionConfig = SETTLEMENT_REGIONS[region];
  if (!regionConfig) {
    throw Object.assign(new Error(`Unknown settlement region: ${region}`), { code: 'INVALID_REGION' });
  }
  const networkAssessment = amount * regionConfig.assessmentRate;
  const tier = getBenefitTier(amount);
  const cashback = (amount + networkAssessment) * tier.rate;
  return {
    amount,
    networkAssessment: Math.round(networkAssessment * 100) / 100,
    cashback: Math.round(cashback * 100) / 100,
    tierLabel: tier.label,
    settled: Math.round((amount + networkAssessment - cashback) * 100) / 100,
    currency: regionConfig.currency,
  };
}

/**
 * Formats the settlement statement for the authorization confirmation.
 * BUG: VISA-CASHBACK-2026 is not in CATALOG, so product.name crashes.
 */
function formatStatement(allItems) {
  return allItems.map((item) => {
    const product = CATALOG.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: product.name,
      category: product.category,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * Processes a Visa payment authorization request.
 */
async function processAuthorization(authData) {
  const startTime = Date.now();
  const authId = uuidv4();

  logger.info('Processing Visa authorization', {
    authId,
    userId: authData.userId,
    amount: authData.amount,
    service: 'visa-acceptance',
    route: '/api/visa/authorize',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyRewards(authData.items);

    const computedAmount = allItems.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    ) || authData.amount;

    const finalAmount = typeof computedAmount === 'string'
      ? parseFloat(computedAmount)
      : computedAmount;

    const result = computeSettlement(finalAmount, authData.region);
    const statement = formatStatement(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/visa/authorize',
      source: 'visa-acceptance',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/visa/authorize',
    });

    return {
      success: true,
      authId,
      approvalCode: authId.slice(0, 6).toUpperCase(),
      settled: result.settled,
      networkAssessment: result.networkAssessment,
      cashback: result.cashback,
      tierLabel: result.tierLabel,
      currency: result.currency,
      statement,
      status: 'approved',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/visa/authorize',
      errorClass: error.name,
      source: 'visa-acceptance',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/visa/authorize',
      error: 'true',
    });

    logger.error('Visa authorization failed', {
      authId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: authData.userId,
      service: 'visa-acceptance',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/visa/authorize',
        service: 'visa-acceptance',
        source: 'visa-acceptance',
      },
      extra: {
        authId,
        userId: authData.userId,
        amount: authData.amount,
        region: authData.region,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/visa.js \u2014 formatStatement',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'visa',
      devinUserId: authData.devinUserId,
      devinEmail: authData.devinEmail,
      devinOrgId: authData.devinOrgId,
      service: 'visa-acceptance',
      verticalLabel: 'Visa Payment Authorization',
      tags: [
        { key: 'route', value: '/api/visa/authorize' },
        { key: 'service', value: 'visa-acceptance' },
      ],
      extra: { authId, userId: authData.userId, amount: authData.amount },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'visa-acceptance@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Visa authorization error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processAuthorization, computeSettlement, formatStatement, applyRewards, CATALOG, SETTLEMENT_REGIONS };
