const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/46ce04a1/copay-benefit';
const SERVICE = '46ce04a1-copay-api';

/** Fictional brand and cardholders — demo data only. */
const PRODUCTS = {
  'VLR-30': { name: 'Veloxa (veloratide) 30-day pen', listPrice: 1050, daysSupply: 30 },
  'VLR-90': { name: 'Veloxa (veloratide) 90-day pack', listPrice: 3150, daysSupply: 90 },
};

const CARDHOLDERS = {
  'VLX-5520-1187': { name: 'Jordan Rivera', insurance: 'Commercial', annualBenefitUsed: 1200 },
  'VLX-5520-2044': { name: 'Marisol Vega', insurance: 'Commercial', annualBenefitUsed: 0 },
};

const ANNUAL_MAX = 7200;
const MIN_PATIENT_PAY = 25;

/**
 * Savings-card tiers by the patient's out-of-pocket amount at the pharmacy counter.
 * The card covers everything above the patient's minimum, up to tier.cardMax.
 */
const BENEFIT_TIERS = [
  { maxOop: 250, cardMax: 225 },
  { maxOop: 600, cardMax: 575 },
  { maxOop: 1000, cardMax: 900 },
];

function tierFor(outOfPocket) {
  return BENEFIT_TIERS.find((t) => outOfPocket <= t.maxOop);
}

function applyCard(outOfPocket, remainingAnnual) {
  const tier = tierFor(outOfPocket);
  const cardPays = Math.min(Math.max(outOfPocket - MIN_PATIENT_PAY, 0), tier.cardMax, remainingAnnual);
  return { cardPays, patientPays: Math.round((outOfPocket - cardPays) * 100) / 100 };
}

class ValidationError extends Error {
  constructor(message) { super(message); this.name = 'ValidationError'; }
}

async function calculateCopayBenefit(data) {
  const startTime = Date.now();
  const claimId = `CPY-${uuidv4().slice(0, 8).toUpperCase()}`;
  logger.info('Calculating copay card benefit', { claimId, cardId: data.cardId, ndc: data.productId, service: SERVICE });

  const cardholder = CARDHOLDERS[data.cardId];
  const product = PRODUCTS[data.productId];
  if (!cardholder || !product) throw new ValidationError('Unknown card or product');
  const outOfPocket = Number(data.insuranceOutOfPocket);
  if (!Number.isFinite(outOfPocket) || outOfPocket < 0) throw new ValidationError('Invalid out-of-pocket amount');

  try {
    const remainingAnnual = ANNUAL_MAX - cardholder.annualBenefitUsed;
    const { cardPays, patientPays } = applyCard(outOfPocket, remainingAnnual);
    incrementMetric('copay_card.success', { route: ROUTE, product: data.productId });
    recordTiming('copay_card.latency', Date.now() - startTime, { route: ROUTE });
    return {
      success: true, claimId, cardholder: cardholder.name, product: product.name, pharmacy: data.pharmacy || 'Retail pharmacy',
      insuranceOutOfPocket: outOfPocket, cardPays, patientPays, remainingAnnual: remainingAnnual - cardPays,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    incrementMetric('copay_card.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('copay_card.latency', Date.now() - startTime, { route: ROUTE, error: 'true' });
    logger.error('Copay card benefit failed', { claimId, error: error.message, errorClass: error.name, product: data.productId, outOfPocket });
    Sentry.captureException(error, { tags: { route: ROUTE, service: SERVICE, product: data.productId }, extra: { claimId, cardId: data.cardId, outOfPocket } });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/46ce04a1.js — calculateCopayBenefit',
      errorType: error.name || 'Error', errorValue: error.message,
      devinUserId: data.devinUserId, devinEmail: data.devinEmail, devinOrgId: data.devinOrgId,
      service: SERVICE, verticalLabel: 'Copay Savings Card (Pharma)', customer: '46ce04a1',
      tags: [{ key: 'route', value: ROUTE }, { key: 'service', value: SERVICE }, { key: 'product', value: String(data.productId) }],
      extra: { claimId, cardId: data.cardId, insuranceOutOfPocket: outOfPocket },
      level: 'error', platform: 'node', firstSeen: '', lastSeen: new Date().toISOString(), count: '', shortId: '',
      project: 'event-driven-devin', release: process.env.SENTRY_RELEASE || '46ce04a1@1.0.0',
      environment: process.env.DD_ENV || 'prod', triggeredRule: '',
    }).catch((err) => logger.error('Failed to trigger Devin session from copay card error', { error: err.message }));
    throw error;
  }
}

module.exports = { calculateCopayBenefit, applyCard, tierFor, PRODUCTS, CARDHOLDERS, BENEFIT_TIERS, ValidationError };
