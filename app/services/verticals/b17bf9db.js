const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/b17bf9db/quotes';
const SERVICE = 'ctm-car-quote-engine';
const SLACK_MEMBER_ID = process.env.CTM_SLACK_MEMBER_ID || '';

/**
 * Vehicle lookup (DVLA / MID enrichment) keyed by normalised registration.
 */
const VEHICLES = {
  EV24TSL: {
    registration: 'EV24 TSL', make: 'Tesla', model: 'Model 3', trim: 'Long Range AWD', year: 2024,
    fuelType: 'electric', transmission: 'Automatic', doors: 4, seats: 5, insuranceGroup: 48, value: 38500,
  },
  FD21KXP: {
    registration: 'FD21 KXP', make: 'Ford', model: 'Fiesta', trim: '1.0 EcoBoost ST-Line', year: 2021,
    fuelType: 'petrol', transmission: 'Manual', doors: 5, seats: 5, insuranceGroup: 14, value: 12750,
  },
  HY23RAV: {
    registration: 'HY23 RAV', make: 'Toyota', model: 'RAV4', trim: '2.5 Hybrid Design', year: 2023,
    fuelType: 'hybrid', transmission: 'Automatic', doors: 5, seats: 5, insuranceGroup: 31, value: 29900,
  },
  BD19VWG: {
    registration: 'BD19 VWG', make: 'Volkswagen', model: 'Golf', trim: '2.0 TDI Match', year: 2019,
    fuelType: 'diesel', transmission: 'Manual', doors: 5, seats: 5, insuranceGroup: 19, value: 14200,
  },
};

/**
 * Rating loadings by fuel type (pricing table v2026.10).
 */
const FUEL_TYPE_LOADINGS = {
  petrol: { factor: 1.0, label: 'Petrol' },
  diesel: { factor: 1.04, label: 'Diesel' },
  hybrid: { factor: 0.97, label: 'Hybrid' },
  ev: { factor: 1.16, label: 'Battery electric' },
};

const COVER_TYPES = {
  comprehensive: { factor: 1.0, label: 'Comprehensive' },
  tpft: { factor: 1.12, label: 'Third party, fire & theft' },
  tpo: { factor: 1.21, label: 'Third party only' },
};

const VOLUNTARY_EXCESS = { 0: 1.0, 100: 0.97, 250: 0.93, 500: 0.88 };

/**
 * Insurer panel returned on the results page.
 */
const INSURER_PANEL = [
  { id: '1stcentral', name: '1st Central', product: 'Comprehensive', baseRate: 512, compulsoryExcess: 250, logo: '1stcentral.png', features: ['Courtesy car', 'Windscreen cover', 'Motor legal protection'] },
  { id: 'admiral', name: 'Admiral', product: 'Admiral Car Insurance', baseRate: 548, compulsoryExcess: 250, logo: 'admiral.png', features: ['Courtesy car', 'Windscreen cover', 'Personal belongings'] },
  { id: 'lv', name: 'LV=', product: 'LV= Comprehensive', baseRate: 571, compulsoryExcess: 200, logo: 'lv.png', features: ['Courtesy car', 'Windscreen cover', '24/7 claims line'] },
  { id: 'aviva', name: 'Aviva', product: 'Aviva Plus', baseRate: 589, compulsoryExcess: 250, logo: 'aviva.png', features: ['Courtesy car', 'Windscreen cover', 'Uninsured driver promise'] },
  { id: 'ageas', name: 'Ageas', product: 'Ageas Comprehensive', baseRate: 603, compulsoryExcess: 300, logo: 'ageas.png', features: ['Courtesy car', 'Windscreen cover'] },
  { id: 'esure', name: 'esure', product: 'esure Car Insurance', baseRate: 627, compulsoryExcess: 250, logo: 'esure.png', features: ['Windscreen cover', 'Motor legal protection'] },
];

function roundPounds(n) {
  return Math.round(n * 100) / 100;
}

function normaliseRegistration(reg) {
  return String(reg || '').replace(/\s+/g, '').toUpperCase();
}

function lookupVehicle(registration) {
  return VEHICLES[normaliseRegistration(registration)] || null;
}

function ageOn(dateOfBirth, now = new Date()) {
  const dob = new Date(dateOfBirth);
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) age -= 1;
  return age;
}

function ageFactor(age) {
  if (age < 21) return 2.4;
  if (age < 25) return 1.7;
  if (age < 30) return 1.2;
  if (age < 70) return 1.0;
  return 1.15;
}

function ncdDiscount(years) {
  return 1 - Math.min(Math.max(Number(years) || 0, 0), 9) * 0.065;
}

function mileageFactor(miles) {
  if (miles <= 5000) return 0.92;
  if (miles <= 10000) return 1.0;
  if (miles <= 15000) return 1.08;
  return 1.17;
}

/**
 * Combines the driver, vehicle and cover answers into a single rating
 * multiplier applied to every insurer's base rate.
 */
function buildRiskProfile(vehicle, driver, cover) {
  const fuelLoading = FUEL_TYPE_LOADINGS[vehicle.fuelType].factor;
  const groupLoading = 0.75 + vehicle.insuranceGroup / 100;
  const valueLoading = 0.85 + Math.min(vehicle.value, 80000) / 100000;
  const multiplier = ageFactor(ageOn(driver.dateOfBirth))
    * ncdDiscount(cover.ncdYears)
    * mileageFactor(cover.annualMileage)
    * COVER_TYPES[cover.type].factor
    * (VOLUNTARY_EXCESS[cover.voluntaryExcess] || 1)
    * fuelLoading
    * groupLoading
    * valueLoading;
  return { multiplier, fuelLoading, groupLoading, valueLoading };
}

const COMPREHENSIVE_ONLY_FEATURES = ['Courtesy car', 'Windscreen cover', 'Personal belongings'];

function priceQuotes(vehicle, risk, cover) {
  const comprehensive = cover.type === 'comprehensive';
  return INSURER_PANEL.map((insurer) => {
    const annual = roundPounds(insurer.baseRate * risk.multiplier);
    return {
      insurerId: insurer.id,
      insurer: insurer.name,
      product: comprehensive ? insurer.product : `${insurer.name} ${COVER_TYPES[cover.type].label}`,
      logo: insurer.logo,
      annualPrice: annual,
      monthlyPrice: roundPounds((annual * 1.099) / 12),
      compulsoryExcess: insurer.compulsoryExcess,
      voluntaryExcess: Number(cover.voluntaryExcess) || 0,
      totalExcess: insurer.compulsoryExcess + (Number(cover.voluntaryExcess) || 0),
      features: comprehensive
        ? insurer.features
        : insurer.features.filter((f) => !COMPREHENSIVE_ONLY_FEATURES.includes(f)),
      meerkatRewards: true,
    };
  }).sort((a, b) => a.annualPrice - b.annualPrice);
}

/**
 * Runs a Compare the Market car insurance quote against the insurer panel.
 */
async function processQuote(quoteData) {
  const startTime = Date.now();
  const quoteRef = `CTM-${uuidv4().slice(0, 8).toUpperCase()}`;
  const requestId = quoteData.requestId || uuidv4();
  const { vehicle, driver, cover } = quoteData;

  logger.info('Processing CTM car insurance quote', {
    quoteRef,
    requestId,
    registration: vehicle.registration,
    fuelType: vehicle.fuelType,
    coverType: cover.type,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 400));

    const risk = buildRiskProfile(vehicle, driver, cover);
    const quotes = priceQuotes(vehicle, risk, cover);

    const duration = Date.now() - startTime;
    incrementMetric('quote.success', { route: ROUTE, source: 'ctm-car-journey' });
    recordTiming('quote.latency', duration, { route: ROUTE });

    return {
      success: true,
      quoteRef,
      vehicle,
      coverType: COVER_TYPES[cover.type].label,
      providersSearched: 112,
      quotes,
      cheapest: quotes[0],
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('quote.failure', { route: ROUTE, errorClass: error.name, source: 'ctm-car-journey' });
    recordTiming('quote.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('CTM car insurance quote failed', {
      quoteRef,
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      registration: vehicle.registration,
      fuelType: vehicle.fuelType,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, source: 'ctm-car-journey', alert_path: 'instant',
      },
      extra: {
        quoteRef, registration: vehicle.registration, fuelType: vehicle.fuelType, coverType: cover.type,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b17bf9db.js \u2014 buildRiskProfile',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'b17bf9db',
      devinUserId: quoteData.devinUserId,
      devinEmail: quoteData.devinEmail,
      devinOrgId: quoteData.devinOrgId,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Compare the Market \u2014 Car Insurance Quote',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'fuel_type', value: String(vehicle.fuelType) },
        { key: 'cover_type', value: String(cover.type) },
      ],
      extra: {
        quoteRef, registration: vehicle.registration, make: vehicle.make, model: vehicle.model,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.10.2`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from CTM quote error', { error: err.message });
    });

    error.quoteRef = quoteRef;
    throw error;
  }
}

module.exports = {
  processQuote,
  lookupVehicle,
  buildRiskProfile,
  priceQuotes,
  normaliseRegistration,
  VEHICLES,
  FUEL_TYPE_LOADINGS,
  COVER_TYPES,
  VOLUNTARY_EXCESS,
  INSURER_PANEL,
};
