const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Credit card products with base annual fee and reward configuration.
 */
const CARDS = {
  clasica: { code: 'CLASICA', name: 'Tarjeta Cl\u00e1sica', annualFee: 0, rewardRate: 0.005 },
  oro: { code: 'ORO', name: 'Tarjeta Oro', annualFee: 1200, rewardRate: 0.01, promo: { monthsWaived: 12, label: '12 meses sin anualidad' } },
  joy: { code: 'JOY', name: 'Tarjeta Joy', annualFee: 700, rewardRate: 0.015, promo: { monthsWaived: 12, label: '12 meses sin anualidad' } },
  costco: { code: 'COSTCO', name: 'Tarjeta Costco', annualFee: 600, rewardRate: 0.02, promo: { monthsWaived: 6, label: '6 meses sin anualidad' } },
};

/**
 * Optional protections and benefits that can be added to an application.
 */
const BENEFITS = [
  { id: 'seguroproteccion', label: 'Seguro de Protecci\u00f3n de Pagos', price: 89, saves: 30 },
  { id: 'asistencias', label: 'Asistencias M\u00e9dicas y Viaje', price: 49, saves: 15 },
  { id: 'mesessinintereses', label: 'Meses Sin Intereses', price: 0, saves: 20 },
];

function findCard(cardId) {
  return CARDS[cardId] || CARDS.clasica;
}

/**
 * Compute the monthly cost breakdown for a card and requested term.
 */
function computeCardPricing(card, term) {
  const monthlyFee = card.annualFee / 12;
  const termFactor = term >= 12 ? 1 : 1.1;
  const monthly = monthlyFee * termFactor;

  return {
    code: card.code,
    annualFee: card.annualFee,
    monthlyFee: Math.round(monthlyFee * 100) / 100,
    termFactor,
    monthly: Math.round(monthly * 100) / 100,
    rewardRate: card.rewardRate,
  };
}

/**
 * Build the savings summary, factoring in the promotional waiver
 * applied to the selected card product.
 */
function buildSavingsSummary(card, pricing, benefits) {
  const waivedMonths = card.promo.monthsWaived;
  const bundleSavings = benefits.reduce((sum, b) => sum + b.saves, 0);
  const promoSavings = (card.annualFee / 12) * waivedMonths;

  return {
    promoLabel: card.promo.label,
    waivedMonths,
    promoSavings: Math.round(promoSavings * 100) / 100,
    bundleSavings,
    totalSavings: Math.round((promoSavings + bundleSavings) * 100) / 100,
  };
}

/**
 * Assemble the final card offer shown to the prospective customer.
 */
function assembleOffer(card, pricing, savings, benefits, term) {
  const benefitsCost = benefits.reduce((sum, b) => sum + b.price, 0);
  const monthlyTotal = pricing.monthly + benefitsCost - savings.bundleSavings;

  return {
    card: card.code,
    cardName: card.name,
    term,
    annualFee: pricing.annualFee,
    promoLabel: savings.promoLabel,
    rewardRate: pricing.rewardRate,
    benefits: benefits.map((b) => ({ label: b.label, price: b.price })),
    benefitsCost,
    totalSavings: savings.totalSavings,
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
  };
}

/**
 * Processes a credit card application/offer request.
 */
async function processCardRequest(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing credit card application request', {
    requestId,
    card: data.card,
    term: data.term,
    service: 'customer-054f8313-cards',
    route: '/api/054f8313/apply',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const card = findCard(data.card);
    const pricing = computeCardPricing(card, data.term);
    const selectedBenefits = (data.benefits || [])
      .map((id) => BENEFITS.find((b) => b.id === id))
      .filter(Boolean);
    const savings = buildSavingsSummary(card, pricing, selectedBenefits);
    const offer = assembleOffer(card, pricing, savings, selectedBenefits, data.term);

    offer.requestId = requestId;
    offer.quotedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('card_application.success', {
      route: '/api/054f8313/apply',
      card: data.card,
    });
    recordTiming('card_application.latency', duration, {
      route: '/api/054f8313/apply',
    });

    return offer;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('card_application.failure', {
      route: '/api/054f8313/apply',
      errorClass: error.name,
    });
    recordTiming('card_application.latency', duration, {
      route: '/api/054f8313/apply',
      error: 'true',
    });

    logger.error('Credit card application failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      card: data.card,
      term: data.term,
      service: 'customer-054f8313-cards',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/054f8313/apply',
        service: 'customer-054f8313-cards',
        card: data.card,
      },
      extra: { requestId, card: data.card, term: data.term },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/054f8313.js \u2014 buildSavingsSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-054f8313-cards',
      verticalLabel: 'Credit Card Application',
      customer: '054f8313',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/054f8313/apply' },
        { key: 'service', value: 'customer-054f8313-cards' },
        { key: 'card', value: data.card },
      ],
      extra: { requestId, card: data.card, term: data.term },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-054f8313-cards@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for card application error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processCardRequest, CARDS, BENEFITS };
