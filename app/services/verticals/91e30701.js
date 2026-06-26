const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * IT product editions with base per-seat licensing and support tier.
 */
const EDITIONS = {
  starter: { code: 'STARTER', name: 'Starter', seatPrice: 25, supportLevel: 'standard' },
  professional: { code: 'PRO', name: 'Professional', seatPrice: 45, supportLevel: 'priority', promo: { seatDiscount: 5, label: 'Annual commitment pricing' } },
  enterprise: { code: 'ENT', name: 'Enterprise', seatPrice: 80, supportLevel: 'dedicated', promo: { seatDiscount: 12, label: 'Annual commitment pricing' } },
  unlimited: { code: 'UNL', name: 'Unlimited', seatPrice: 120, supportLevel: 'dedicated', promo: { seatDiscount: 20, label: 'Annual commitment pricing' } },
};

/**
 * Optional add-on modules that can be bundled into a deployment.
 */
const MODULES = [
  { id: 'analytics', label: 'Advanced Analytics', price: 15, saves: 5 },
  { id: 'integration', label: 'Integration Suite', price: 25, saves: 8 },
  { id: 'managedcloud', label: 'Managed Cloud Hosting', price: 30, saves: 10 },
];

function findEdition(editionId) {
  return EDITIONS[editionId] || EDITIONS.starter;
}

/**
 * Compute the per-seat and total monthly pricing for an edition.
 */
function computeEditionPricing(edition, seats) {
  const seatCount = seats > 0 ? seats : 1;
  const volumeFactor = seatCount >= 100 ? 0.9 : 1;
  const perSeat = edition.seatPrice * volumeFactor;

  return {
    code: edition.code,
    seatCount,
    perSeat: Math.round(perSeat * 100) / 100,
    supportLevel: edition.supportLevel,
    monthly: Math.round(perSeat * seatCount * 100) / 100,
  };
}

/**
 * Build the savings summary, factoring in the promotional discount
 * applied to the selected product edition.
 */
function buildSavingsSummary(edition, pricing, modules) {
  const seatDiscount = edition.promo.seatDiscount;
  const bundleSavings = modules.reduce((sum, m) => sum + m.saves, 0);
  const promoSavings = seatDiscount * pricing.seatCount;

  return {
    promoLabel: edition.promo.label,
    seatDiscount,
    promoSavings: Math.round(promoSavings * 100) / 100,
    bundleSavings,
    totalSavings: Math.round((promoSavings + bundleSavings) * 100) / 100,
  };
}

/**
 * Assemble the final solution quote shown to the prospective client.
 */
function assembleQuote(edition, pricing, savings, modules, seats) {
  const modulesCost = modules.reduce((sum, m) => sum + m.price, 0);
  const monthlyTotal = pricing.monthly + modulesCost - savings.bundleSavings;

  return {
    edition: edition.code,
    editionName: edition.name,
    seats,
    perSeat: pricing.perSeat,
    supportLevel: pricing.supportLevel,
    promoLabel: savings.promoLabel,
    modules: modules.map((m) => ({ label: m.label, price: m.price })),
    modulesCost,
    totalSavings: savings.totalSavings,
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
  };
}

/**
 * Processes an IT solution quote/consultation request.
 */
async function processQuoteRequest(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing IT solution quote request', {
    requestId,
    edition: data.edition,
    seats: data.seats,
    service: 'customer-91e30701-solutions',
    route: '/api/91e30701/quote',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const edition = findEdition(data.edition);
    const pricing = computeEditionPricing(edition, data.seats);
    const selectedModules = (data.modules || [])
      .map((id) => MODULES.find((m) => m.id === id))
      .filter(Boolean);
    const savings = buildSavingsSummary(edition, pricing, selectedModules);
    const quote = assembleQuote(edition, pricing, savings, selectedModules, data.seats);

    quote.requestId = requestId;
    quote.quotedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('solution_quote.success', {
      route: '/api/91e30701/quote',
      edition: data.edition,
    });
    recordTiming('solution_quote.latency', duration, {
      route: '/api/91e30701/quote',
    });

    return quote;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('solution_quote.failure', {
      route: '/api/91e30701/quote',
      errorClass: error.name,
    });
    recordTiming('solution_quote.latency', duration, {
      route: '/api/91e30701/quote',
      error: 'true',
    });

    logger.error('IT solution quote failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      edition: data.edition,
      seats: data.seats,
      service: 'customer-91e30701-solutions',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/91e30701/quote',
        service: 'customer-91e30701-solutions',
        edition: data.edition,
      },
      extra: { requestId, edition: data.edition, seats: data.seats },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/91e30701.js \u2014 buildSavingsSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-91e30701-solutions',
      verticalLabel: 'IT Solution Quote',
      customer: '91e30701',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/91e30701/quote' },
        { key: 'service', value: 'customer-91e30701-solutions' },
        { key: 'edition', value: data.edition },
      ],
      extra: { requestId, edition: data.edition, seats: data.seats },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-91e30701-solutions@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for solution quote error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processQuoteRequest, EDITIONS, MODULES };
