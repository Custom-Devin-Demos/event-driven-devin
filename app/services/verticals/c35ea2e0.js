const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Equipment lines with base list price and standard lease term.
 */
const EQUIPMENT = {
  aerial: { code: 'AERIAL', name: 'Aerial Work Platform', listPrice: 85000, term: 48 },
  materials: { code: 'MP', name: 'Materials Processing Plant', listPrice: 320000, term: 60, promo: { rateReduction: 1.5, label: 'Fleet program rate' } },
  specialty: { code: 'SPV', name: 'Specialty Vehicle', listPrice: 540000, term: 72, promo: { rateReduction: 2, label: 'Fleet program rate' } },
  environmental: { code: 'ENV', name: 'Environmental Solution', listPrice: 410000, term: 60, promo: { rateReduction: 1.75, label: 'Fleet program rate' } },
};

/**
 * Service and support packages that can be bundled with a unit.
 */
const SUPPORT = [
  { id: 'genuineparts', label: 'Genuine Parts Plan', price: 4800, saves: 1200 },
  { id: 'telematics', label: 'Terex Telematics', price: 3600, saves: 900 },
  { id: 'extendedwarranty', label: 'Extended Warranty', price: 7200, saves: 2000 },
];

function findEquipment(equipmentId) {
  return EQUIPMENT[equipmentId] || EQUIPMENT.aerial;
}

/**
 * Compute the monthly lease payment for a unit over the chosen term.
 */
function computeLeasePricing(equipment, term) {
  const months = term > 0 ? term : equipment.term;
  const baseRate = 5.5;
  const residual = equipment.listPrice * 0.2;
  const financed = equipment.listPrice - residual;
  const monthly = (financed / months) * (1 + baseRate / 100);

  return {
    code: equipment.code,
    months,
    baseRate,
    residual,
    monthly: Math.round(monthly * 100) / 100,
    listPrice: equipment.listPrice,
  };
}

/**
 * Build the savings summary, factoring in the promotional rate
 * reduction applied to the selected equipment line.
 */
function buildSavingsSummary(equipment, pricing, support) {
  const promo = equipment.promo;
  const rateReduction = promo ? promo.rateReduction : 0;
  const bundleSavings = support.reduce((sum, s) => sum + s.saves, 0);
  const rateSavings = (pricing.listPrice * (rateReduction / 100));

  return {
    promoLabel: promo ? promo.label : 'No promotion',
    rateReduction,
    rateSavings: Math.round(rateSavings * 100) / 100,
    bundleSavings,
    totalSavings: Math.round((rateSavings + bundleSavings) * 100) / 100,
  };
}

/**
 * Assemble the final equipment quote shown to the prospective buyer.
 */
function assembleQuote(equipment, pricing, savings, support, term) {
  const supportCost = support.reduce((sum, s) => sum + s.price, 0);
  const total = pricing.listPrice + supportCost - savings.bundleSavings;

  return {
    equipment: equipment.code,
    equipmentName: equipment.name,
    term,
    listPrice: pricing.listPrice,
    monthlyLease: pricing.monthly,
    promoLabel: savings.promoLabel,
    support: support.map((s) => ({ label: s.label, price: s.price })),
    supportCost,
    totalSavings: savings.totalSavings,
    total: Math.round(total * 100) / 100,
  };
}

/**
 * Processes an equipment quote/financing request.
 */
async function processQuoteRequest(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing equipment quote request', {
    requestId,
    equipment: data.equipment,
    term: data.term,
    service: 'customer-c35ea2e0-equipment',
    route: '/api/c35ea2e0/quote',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const equipment = findEquipment(data.equipment);
    const pricing = computeLeasePricing(equipment, data.term);
    const selectedSupport = (data.support || [])
      .map((id) => SUPPORT.find((s) => s.id === id))
      .filter(Boolean);
    const savings = buildSavingsSummary(equipment, pricing, selectedSupport);
    const quote = assembleQuote(equipment, pricing, savings, selectedSupport, data.term);

    quote.requestId = requestId;
    quote.quotedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('equipment_quote.success', {
      route: '/api/c35ea2e0/quote',
      equipment: data.equipment,
    });
    recordTiming('equipment_quote.latency', duration, {
      route: '/api/c35ea2e0/quote',
    });

    return quote;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('equipment_quote.failure', {
      route: '/api/c35ea2e0/quote',
      errorClass: error.name,
    });
    recordTiming('equipment_quote.latency', duration, {
      route: '/api/c35ea2e0/quote',
      error: 'true',
    });

    logger.error('Equipment quote failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      equipment: data.equipment,
      term: data.term,
      service: 'customer-c35ea2e0-equipment',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/c35ea2e0/quote',
        service: 'customer-c35ea2e0-equipment',
        equipment: data.equipment,
      },
      extra: { requestId, equipment: data.equipment, term: data.term },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/c35ea2e0.js \u2014 buildSavingsSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-c35ea2e0-equipment',
      verticalLabel: 'Equipment Quote',
      customer: 'c35ea2e0',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/c35ea2e0/quote' },
        { key: 'service', value: 'customer-c35ea2e0-equipment' },
        { key: 'equipment', value: data.equipment },
      ],
      extra: { requestId, equipment: data.equipment, term: data.term },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-c35ea2e0-equipment@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for equipment quote error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processQuoteRequest, buildSavingsSummary, EQUIPMENT, SUPPORT };
