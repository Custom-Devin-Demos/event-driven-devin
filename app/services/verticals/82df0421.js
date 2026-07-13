const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Vehicle rating classes keyed by body style.
 */
const VEHICLE_CLASSES = {
  sedan: { label: 'Sedan', riskFactor: 1.0, comprehensive: 0.9 },
  suv: { label: 'SUV', riskFactor: 1.15, comprehensive: 1.05 },
  truck: { label: 'Truck', riskFactor: 1.25, comprehensive: 1.1 },
  sports: { label: 'Sports Car', riskFactor: 1.6, comprehensive: 1.4 },
  ev: { label: 'Electric', riskFactor: 1.1, comprehensive: 1.2 },
};

/**
 * Territory rating data keyed by state code.
 */
const TERRITORIES = {
  MD: { name: 'Maryland', base: 68.4, multiplier: 1.08 },
  VA: { name: 'Virginia', base: 61.2, multiplier: 1.0 },
  DC: { name: 'District of Columbia', base: 79.5, multiplier: 1.22 },
  CA: { name: 'California', base: 74.1, multiplier: 1.18 },
  TX: { name: 'Texas', base: 66.0, multiplier: 1.05 },
};

/**
 * Coverage packages and their premium factors.
 */
const COVERAGE_PACKAGES = [
  { id: 'liability', label: 'Liability Only', factor: 0.72, deductible: 0 },
  { id: 'standard', label: 'Standard', factor: 1.0, deductible: 500 },
  { id: 'full', label: 'Full Coverage', factor: 1.35, deductible: 250 },
];

/**
 * Discounts available on an auto policy.
 */
const DISCOUNTS = [
  { code: 'multi-policy', label: 'Multi-Policy', pct: 0.15 },
  { code: 'good-driver', label: 'Good Driver', pct: 0.1 },
  { code: 'good-student', label: 'Good Student', pct: 0.08 },
  { code: 'military', label: 'Military', pct: 0.12 },
];

function resolveVehicle(vehicleType) {
  return VEHICLE_CLASSES[vehicleType] || VEHICLE_CLASSES.sedan;
}

function resolveTerritory(state) {
  return TERRITORIES[state] || TERRITORIES.VA;
}

function resolveCoverage(coverageId) {
  return COVERAGE_PACKAGES.find((c) => c.id === coverageId) || COVERAGE_PACKAGES[1];
}

/**
 * Age-based rating surcharge/credit applied to the monthly premium.
 */
function driverAgeFactor(driverAge) {
  if (driverAge < 21) return 1.45;
  if (driverAge < 25) return 1.2;
  if (driverAge >= 65) return 1.1;
  return 1.0;
}

/**
 * Build the set of rating factors that feed the premium calculation.
 */
function buildRatingFactors(vehicle, territory, coverage) {
  return [
    { category: 'territory', base: territory.base, multiplier: territory.multiplier },
    { category: 'vehicle', multiplier: vehicle.riskFactor, comprehensive: vehicle.comprehensive },
    { category: 'coverage', multiplier: coverage.factor, deductible: coverage.deductible },
  ];
}

/**
 * Compute the base monthly and annual premium from the rating factors.
 */
function computeBasePremium(factors, ageFactor) {
  const monthly = factors.territory.base
    * factors.vehicle.multiplier
    * factors.coverage.multiplier
    * ageFactor;

  return {
    monthly: Math.round(monthly * 100) / 100,
    annual: Math.round(monthly * 12 * 100) / 100,
  };
}

/**
 * Apply eligible discounts to the base premium.
 */
function applyDiscounts(basePremium, discountCodes) {
  const applied = (discountCodes || [])
    .map((code) => DISCOUNTS.find((d) => d.code === code))
    .filter(Boolean);

  const totalPct = applied.reduce((sum, d) => sum + d.pct, 0);
  const monthly = basePremium.monthly * (1 - totalPct);

  return {
    applied: applied.map((d) => ({ label: d.label, pct: d.pct })),
    totalPct,
    monthly: Math.round(monthly * 100) / 100,
    annual: Math.round(monthly * 12 * 100) / 100,
  };
}

/**
 * Assemble the customer-facing quote summary.
 */
function assembleQuote(vehicle, territory, coverage, factors, discounted) {
  return {
    vehicle: vehicle.label,
    territory: territory.name,
    coverage: coverage.label,
    deductible: factors.coverage.deductible,
    monthlyPremium: discounted.monthly,
    annualPremium: discounted.annual,
    discountsApplied: discounted.applied,
    comprehensiveFactor: factors.vehicle.comprehensive,
  };
}

/**
 * Processes an auto insurance quote request.
 */
async function processQuote(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing auto quote', {
    requestId,
    vehicleType: data.vehicleType,
    state: data.state,
    service: 'customer-82df0421-quote',
    route: '/api/82df0421/quote',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const vehicle = resolveVehicle(data.vehicleType);
    const territory = resolveTerritory(data.state);
    const coverage = resolveCoverage(data.coverageId);
    const ageFactor = driverAgeFactor(data.driverAge || 30);

    const factors = buildRatingFactors(vehicle, territory, coverage);
    const basePremium = computeBasePremium(factors, ageFactor);
    const discounted = applyDiscounts(basePremium, data.discounts);
    const quote = assembleQuote(vehicle, territory, coverage, factors, discounted);

    quote.requestId = requestId;
    quote.quotedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('auto_quote.success', {
      route: '/api/82df0421/quote',
      coverage: data.coverageId,
    });
    recordTiming('auto_quote.latency', duration, {
      route: '/api/82df0421/quote',
    });

    return quote;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('auto_quote.failure', {
      route: '/api/82df0421/quote',
      errorClass: error.name,
    });
    recordTiming('auto_quote.latency', duration, {
      route: '/api/82df0421/quote',
      error: 'true',
    });

    logger.error('Auto quote failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      vehicleType: data.vehicleType,
      state: data.state,
      service: 'customer-82df0421-quote',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/82df0421/quote',
        service: 'customer-82df0421-quote',
        coverage: data.coverageId,
      },
      extra: { requestId, vehicleType: data.vehicleType, state: data.state },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/82df0421.js \u2014 computeBasePremium',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-82df0421-quote',
      verticalLabel: 'Auto Quote',
      customer: '82df0421',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/82df0421/quote' },
        { key: 'service', value: 'customer-82df0421-quote' },
        { key: 'coverage', value: data.coverageId },
      ],
      extra: { requestId, vehicleType: data.vehicleType, state: data.state },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-82df0421-quote@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for auto quote error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processQuote, VEHICLE_CLASSES, TERRITORIES, COVERAGE_PACKAGES, DISCOUNTS };
