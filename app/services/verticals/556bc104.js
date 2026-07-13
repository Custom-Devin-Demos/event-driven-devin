const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Retail card offer catalog with prequalification parameters.
 */
const OFFERS = {
  'AE-REAL-REWARDS': {
    code: 'AE-REAL-REWARDS',
    partner: 'American Eagle',
    product: 'Real Rewards Credit Card',
    baseApr: 29.99,
    introDiscount: 0.3,
    rewards: { pointsPerDollar: 15, welcomeBonus: 2500, redemptionRate: 0.005 },
    creditLine: { floor: 250, ceiling: 3500 },
  },
  'PREMIER-MC': {
    code: 'PREMIER-MC',
    partner: 'Premier',
    product: 'Premier Mastercard',
    baseApr: 26.99,
    introDiscount: 0,
    rewards: { pointsPerDollar: 2, welcomeBonus: 0, redemptionRate: 0.01 },
    creditLine: { floor: 500, ceiling: 10000 },
  },
};

function resolveOffer(offerCode) {
  return OFFERS[offerCode] || OFFERS['PREMIER-MC'];
}

/**
 * Build a soft-pull applicant snapshot used for the prequalification decision.
 */
function buildApplicantSnapshot(channel) {
  const score = 660 + Math.floor(Math.random() * 140);
  return {
    bureau: 'soft-pull',
    channel,
    score,
    band: score >= 740 ? 'excellent' : score >= 700 ? 'good' : 'fair',
    utilization: Math.round(Math.random() * 60) / 100,
  };
}

/**
 * Assemble the decision context for the offer and applicant pair.
 */
function buildDecisionContext(offer, applicant) {
  const lineMultiplier = applicant.band === 'excellent' ? 1 : applicant.band === 'good' ? 0.7 : 0.4;
  const suggestedLine = Math.round(
    Math.min(offer.creditLine.ceiling, Math.max(offer.creditLine.floor, offer.creditLine.ceiling * lineMultiplier))
  );

  return {
    offerCode: offer.code,
    partner: offer.partner,
    product: offer.product,
    apr: offer.baseApr,
    introDiscount: offer.introDiscount,
    suggestedLine,
    band: applicant.band,
    score: applicant.score,
  };
}

/**
 * Compose the final prequalification terms presented to the customer.
 */
function composeOfferTerms(ctx) {
  const firstPurchaseSavings = Math.round(ctx.suggestedLine * ctx.introDiscount * 100) / 100;
  const annualRewardsValue =
    Math.round(ctx.suggestedLine * 12 * 0.2 * ctx.rewards.pointsPerDollar * ctx.rewards.redemptionRate * 100) / 100;

  return {
    offerCode: ctx.offerCode,
    partner: ctx.partner,
    product: ctx.product,
    prequalified: true,
    apr: ctx.apr,
    creditLine: ctx.suggestedLine,
    firstPurchaseSavings,
    welcomeBonus: ctx.rewards.welcomeBonus,
    annualRewardsValue,
    band: ctx.band,
  };
}

/**
 * Processes a prequalification check request.
 */
async function processPrequalification(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing prequalification check', {
    requestId,
    offerCode: data.offerCode,
    channel: data.channel,
    service: 'customer-556bc104-prequal',
    route: '/api/556bc104/prequal',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const offer = resolveOffer(data.offerCode);
    const applicant = buildApplicantSnapshot(data.channel);
    const ctx = buildDecisionContext(offer, applicant);
    const terms = composeOfferTerms(ctx);

    terms.requestId = requestId;
    terms.checkedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('prequal_check.success', {
      route: '/api/556bc104/prequal',
      offerCode: data.offerCode,
    });
    recordTiming('prequal_check.latency', duration, {
      route: '/api/556bc104/prequal',
    });

    return terms;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('prequal_check.failure', {
      route: '/api/556bc104/prequal',
      errorClass: error.name,
    });
    recordTiming('prequal_check.latency', duration, {
      route: '/api/556bc104/prequal',
      error: 'true',
    });

    logger.error('Prequalification check failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      offerCode: data.offerCode,
      channel: data.channel,
      service: 'customer-556bc104-prequal',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/556bc104/prequal',
        service: 'customer-556bc104-prequal',
        offerCode: data.offerCode,
      },
      extra: { requestId, offerCode: data.offerCode, channel: data.channel },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/556bc104.js \u2014 composeOfferTerms',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-556bc104-prequal',
      verticalLabel: 'Card Prequalification',
      customer: '556bc104',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/556bc104/prequal' },
        { key: 'service', value: 'customer-556bc104-prequal' },
        { key: 'offerCode', value: data.offerCode },
      ],
      extra: { requestId, offerCode: data.offerCode, channel: data.channel },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-556bc104-prequal@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for prequalification error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processPrequalification, OFFERS };
