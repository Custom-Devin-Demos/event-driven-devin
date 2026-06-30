const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Insurance products with base monthly premium and coverage tier.
 */
const PRODUCTS = {
  auto: { code: 'AUTO', name: 'Auto', basePremium: 95, coverage: 'standard' },
  homeowners: { code: 'HOME', name: 'Homeowners', basePremium: 140, coverage: 'standard', promo: { discountPct: 15, label: 'Bundle & Save' } },
  renters: { code: 'RENT', name: 'Renters', basePremium: 22, coverage: 'standard', promo: { discountPct: 10, label: 'Bundle & Save' } },
  motorcycle: { code: 'MOTO', name: 'Motorcycle/Off-Road', basePremium: 48, coverage: 'standard', promo: { discountPct: 12, label: 'Bundle & Save' } },
  boat: { code: 'BOAT', name: 'Boat', basePremium: 60, coverage: 'standard', promo: { discountPct: 12, label: 'Bundle & Save' } },
  commercial: { code: 'COMM', name: 'Commercial Auto/Business', basePremium: 210, coverage: 'standard', promo: { discountPct: 18, label: 'Bundle & Save' } },
};

/**
 * Optional coverage add-ons that can be bundled into a policy.
 */
const ADDONS = [
  { id: 'roadside', label: 'Emergency Roadside Service', price: 8, saves: 3 },
  { id: 'rental', label: 'Rental Reimbursement', price: 12, saves: 4 },
  { id: 'mechanical', label: 'Mechanical Breakdown', price: 15, saves: 6 },
];

function findProduct(productId) {
  return PRODUCTS[productId] || PRODUCTS.auto;
}

/**
 * Compute the base monthly premium for a product and driver profile.
 */
function computePremium(product, drivers) {
  const driverCount = drivers > 0 ? drivers : 1;
  const multiDriverFactor = driverCount > 1 ? 1.35 : 1;
  const monthly = product.basePremium * multiDriverFactor;

  return {
    code: product.code,
    driverCount,
    coverage: product.coverage,
    monthly: Math.round(monthly * 100) / 100,
  };
}

/**
 * Build the savings summary, factoring in the promotional bundle
 * discount applied to the selected insurance product.
 */
function buildSavingsSummary(product, pricing, addons) {
  const promo = product.promo || null;
  const discountPct = promo ? promo.discountPct : 0;
  const bundleSavings = addons.reduce((sum, a) => sum + a.saves, 0);
  const promoSavings = (pricing.monthly * discountPct) / 100;

  return {
    promoLabel: promo ? promo.label : null,
    discountPct,
    promoSavings: Math.round(promoSavings * 100) / 100,
    bundleSavings,
    totalSavings: Math.round((promoSavings + bundleSavings) * 100) / 100,
  };
}

/**
 * Assemble the final insurance quote shown to the prospective policyholder.
 */
function assembleQuote(product, pricing, savings, addons, drivers) {
  const addonsCost = addons.reduce((sum, a) => sum + a.price, 0);
  const monthlyTotal = pricing.monthly + addonsCost - savings.promoSavings;

  return {
    product: product.code,
    productName: product.name,
    drivers,
    basePremium: pricing.monthly,
    coverage: pricing.coverage,
    promoLabel: savings.promoLabel,
    addons: addons.map((a) => ({ label: a.label, price: a.price })),
    addonsCost,
    totalSavings: savings.totalSavings,
    monthlyTotal: Math.round(monthlyTotal * 100) / 100,
  };
}

/**
 * Processes an insurance quote request.
 */
async function processQuoteRequest(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing insurance quote request', {
    requestId,
    product: data.product,
    drivers: data.drivers,
    service: 'customer-382b34fc-insurance',
    route: '/api/382b34fc/quote',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const product = findProduct(data.product);
    const pricing = computePremium(product, data.drivers);
    const selectedAddons = (data.addons || [])
      .map((id) => ADDONS.find((a) => a.id === id))
      .filter(Boolean);
    const savings = buildSavingsSummary(product, pricing, selectedAddons);
    const quote = assembleQuote(product, pricing, savings, selectedAddons, data.drivers);

    quote.requestId = requestId;
    quote.quotedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('insurance_quote.success', {
      route: '/api/382b34fc/quote',
      product: data.product,
    });
    recordTiming('insurance_quote.latency', duration, {
      route: '/api/382b34fc/quote',
    });

    return quote;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('insurance_quote.failure', {
      route: '/api/382b34fc/quote',
      errorClass: error.name,
    });
    recordTiming('insurance_quote.latency', duration, {
      route: '/api/382b34fc/quote',
      error: 'true',
    });

    logger.error('Insurance quote failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      product: data.product,
      drivers: data.drivers,
      service: 'customer-382b34fc-insurance',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/382b34fc/quote',
        service: 'customer-382b34fc-insurance',
        product: data.product,
      },
      extra: { requestId, product: data.product, drivers: data.drivers },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/382b34fc.js \u2014 buildSavingsSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-382b34fc-insurance',
      verticalLabel: 'Insurance Quote',
      customer: '382b34fc',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/382b34fc/quote' },
        { key: 'service', value: 'customer-382b34fc-insurance' },
        { key: 'product', value: data.product },
      ],
      extra: { requestId, product: data.product, drivers: data.drivers },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-382b34fc-insurance@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for insurance quote error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processQuoteRequest, PRODUCTS, ADDONS };
