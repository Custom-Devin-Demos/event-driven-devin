/* global setImmediate */

const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SLACK_MEMBER_ID = process.env.IHG_SLACK_MEMBER_ID || 'U08S7AVJ478';

const SERVICE = 'customer-ef51d258-hotel-search';
const ROUTE = '/api/ef51d258/availability';

/**
 * Rate-engine call policy — how many nightly-rate quotes may be in flight at
 * once against the upstream rate engine, and the observed per-call latency.
 *
 * Change log:
 *  - rate-shopper@2.4.0: concurrency 8.
 *  - rate-shopper@2.4.1: an upstream rate-limit incident (RateOps RATES-4471)
 *    dropped concurrency 8 → 1 as a temporary workaround while the rate
 *    engine's per-client throttling was misconfigured.
 *  - RATES-4471 is closed: the partner raised the per-client ceiling to 16
 *    concurrent calls, so any value up to 16 is sanctioned and needs no
 *    further RateOps sign-off; the shipped default was never raised back.
 */
const RATE_QUOTE_POLICY = {
  concurrency: Number(process.env.IHG_RATE_QUOTE_CONCURRENCY) > 0
    ? Math.max(1, Math.floor(Number(process.env.IHG_RATE_QUOTE_CONCURRENCY)))
    : 1,
  latencyMs: [240, 360],
};

const LATENCY_SLO = { budgetMs: 3000 };

const DESTINATIONS = {
  new_york: {
    label: 'New York, NY, United States',
    hotels: [
      { code: 'NYCBH', name: 'InterContinental New York Barclay', brand: 'InterContinental', address: '111 E 48th St, New York, NY 10017', baseRateUsd: 389, pointsPerNight: 65000 },
      { code: 'NYCEV', name: 'Kimpton Hotel Eventi', brand: 'Kimpton', address: '851 6th Ave, New York, NY 10001', baseRateUsd: 329, pointsPerNight: 56000 },
      { code: 'NYCLE', name: 'Hotel Indigo Lower East Side New York', brand: 'Hotel Indigo', address: '171 Ludlow St, New York, NY 10002', baseRateUsd: 249, pointsPerNight: 42000 },
      { code: 'NYCTS', name: 'Crowne Plaza Times Square Manhattan', brand: 'Crowne Plaza', address: '1605 Broadway, New York, NY 10019', baseRateUsd: 289, pointsPerNight: 49000 },
      { code: 'NYCTSS', name: 'EVEN Hotel New York - Times Square South', brand: 'EVEN Hotels', address: '321 W 35th St, New York, NY 10001', baseRateUsd: 219, pointsPerNight: 38000 },
      { code: 'NYCVC', name: 'voco Times Square South', brand: 'voco', address: '343 W 36th St, New York, NY 10018', baseRateUsd: 229, pointsPerNight: 40000 },
      { code: 'NYCHX', name: 'Holiday Inn Express New York City Times Square', brand: 'Holiday Inn Express', address: '343 W 39th St, New York, NY 10018', baseRateUsd: 189, pointsPerNight: 33000 },
      { code: 'NYCSB', name: 'Staybridge Suites Times Square - New York City', brand: 'Staybridge Suites', address: '340 W 40th St, New York, NY 10018', baseRateUsd: 239, pointsPerNight: 41000 },
      { code: 'NYCFD', name: 'Holiday Inn Manhattan Financial District', brand: 'Holiday Inn', address: '99 Washington St, New York, NY 10006', baseRateUsd: 209, pointsPerNight: 36000 },
      { code: 'NYCCW', name: 'Candlewood Suites NYC - Times Square', brand: 'Candlewood Suites', address: '339 W 39th St, New York, NY 10018', baseRateUsd: 199, pointsPerNight: 34000 },
    ],
  },
  chicago: {
    label: 'Chicago, IL, United States',
    hotels: [
      { code: 'CHIMB', name: 'InterContinental Chicago Magnificent Mile', brand: 'InterContinental', address: '505 N Michigan Ave, Chicago, IL 60611', baseRateUsd: 279, pointsPerNight: 50000 },
      { code: 'CHIKN', name: 'Kimpton Gray Hotel', brand: 'Kimpton', address: '122 W Monroe St, Chicago, IL 60603', baseRateUsd: 259, pointsPerNight: 46000 },
    ],
  },
  london: {
    label: 'London, United Kingdom',
    hotels: [
      { code: 'LONPK', name: 'InterContinental London Park Lane', brand: 'InterContinental', address: '1 Hamilton Pl, London W1J 7QY', baseRateUsd: 399, pointsPerNight: 70000 },
      { code: 'LONST', name: 'Hotel Indigo London - 1 Leicester Square', brand: 'Hotel Indigo', address: '1 Leicester Square, London WC2H 7NA', baseRateUsd: 289, pointsPerNight: 52000 },
    ],
  },
  atlanta: {
    label: 'Atlanta, GA, United States',
    hotels: [
      { code: 'ATLBH', name: 'InterContinental Buckhead Atlanta', brand: 'InterContinental', address: '3315 Peachtree Rd NE, Atlanta, GA 30326', baseRateUsd: 239, pointsPerNight: 43000 },
      { code: 'ATLDT', name: 'Hotel Indigo Atlanta Downtown', brand: 'Hotel Indigo', address: '230 Peachtree St NE, Atlanta, GA 30303', baseRateUsd: 169, pointsPerNight: 30000 },
    ],
  },
};

const RATE_PREFERENCES = {
  best_available: { label: 'Best Flexible Rate', discount: 1 },
  points: { label: 'IHG One Rewards Points', discount: 0 },
  aaa: { label: 'AAA/CAA', discount: 0.9 },
  government: { label: 'Government/Military', discount: 0.85 },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The slow code path is the IHG hotel availability search request:',
  '- Service: `app/services/verticals/ef51d258.js`',
  '- Route: `app/routes/verticals/ef51d258.js`',
  '- Page: `app/public/verticals/ef51d258.html` (served at `/ihg`)',
  '',
  'Requests succeed but take ~10s, breaching the 3000ms latency budget and paging on-call.',
  'Find the root cause of the latency and fix it. Do not raise or remove the latency budget, the breach alert, or the simulated dependency latency.',
  'Preserve the response payload for every option.',
  'Run `npx jest tests/ef51d258-hotel-search.test.js --runInBand` and `npm run lint`.',
  'Verify the default availability search at `/ihg` returns in under 3 seconds.',
  'Open a pull request against `main` with the fix.',
].join('\n');

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(date) {
  return date.toISOString().slice(0, 10);
}

function resolveStayDates(data) {
  let { checkIn, checkOut } = data;
  if (!checkIn && !checkOut) {
    const start = new Date(Date.now() + 86400000);
    const end = new Date(start.getTime() + 3 * 86400000);
    checkIn = formatDate(start);
    checkOut = formatDate(end);
  }

  const inDate = parseDate(checkIn);
  const outDate = parseDate(checkOut);
  const nights = inDate && outDate
    ? Math.round((outDate.getTime() - inDate.getTime()) / 86400000)
    : 0;

  if (!inDate || !outDate || nights < 1 || nights > 14) {
    const error = new Error('Enter valid check-in and check-out dates (1–14 nights).');
    error.name = 'ValidationError';
    error.code = 'STAY_DATES_INVALID';
    error.statusCode = 400;
    throw error;
  }

  return { checkIn, checkOut, nights };
}

function validateSearchRequest(data) {
  if (!Object.hasOwn(DESTINATIONS, data.destination || '')) {
    const error = new Error('Select a valid destination.');
    error.name = 'ValidationError';
    error.code = 'SEARCH_DETAILS_INVALID';
    error.statusCode = 400;
    throw error;
  }

  if (!Object.hasOwn(RATE_PREFERENCES, data.ratePreference || 'best_available')) {
    const error = new Error('Select a valid rate preference.');
    error.name = 'ValidationError';
    error.code = 'SEARCH_DETAILS_INVALID';
    error.statusCode = 400;
    throw error;
  }

  resolveStayDates(data);
}

/**
 * Quote one hotel-night from the rate engine. Latency mirrors the observed
 * distribution on the partner endpoint.
 */
async function quoteNightFromRateEngine(hotel, night, discount) {
  const [min, max] = RATE_QUOTE_POLICY.latencyMs;
  await new Promise((resolve) => setTimeout(resolve, min + Math.random() * (max - min)));
  const weekend = night.dayOfWeek === 5 || night.dayOfWeek === 6;
  const price = hotel.baseRateUsd * (weekend ? 1.15 : 1) * discount;
  return Math.round(price * 100) / 100;
}

/**
 * Quote nightly rates for every hotel over every night of the stay. Calls go
 * through the rate engine in batches of RATE_QUOTE_POLICY.concurrency.
 */
async function quoteNightlyRates(hotels, nights, discount) {
  const jobs = [];
  for (const hotel of hotels) {
    for (const night of nights) {
      jobs.push({ hotel, night });
    }
  }

  const quoted = new Map();
  const concurrency = Math.max(1, Math.floor(RATE_QUOTE_POLICY.concurrency) || 1);
  for (let i = 0; i < jobs.length; i += concurrency) {
    const batch = jobs.slice(i, i + concurrency);
    const prices = await Promise.all(
      batch.map((job) => quoteNightFromRateEngine(job.hotel, job.night, discount)),
    );
    batch.forEach((job, index) => {
      quoted.set(`${job.hotel.code}#${job.night.date}`, prices[index]);
    });
  }

  return hotels.map((hotel) => {
    const nightlyRatesUsd = nights.map((night) => quoted.get(`${hotel.code}#${night.date}`));
    const totalUsd = Math.round(nightlyRatesUsd.reduce((sum, price) => sum + price, 0) * 100) / 100;
    return {
      code: hotel.code,
      name: hotel.name,
      brand: hotel.brand,
      address: hotel.address,
      nightlyRatesUsd,
      totalUsd,
      avgNightlyUsd: Math.round((totalUsd / nights.length) * 100) / 100,
      pointsPerNight: hotel.pointsPerNight,
      totalPoints: hotel.pointsPerNight * nights.length,
    };
  }).sort((a, b) => a.avgNightlyUsd - b.avgNightlyUsd);
}

/**
 * Price every hotel from the in-memory award chart — no rate-engine calls.
 */
async function quoteAwardStays(hotels, nights) {
  await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 60));
  return hotels.map((hotel) => ({
    code: hotel.code,
    name: hotel.name,
    brand: hotel.brand,
    address: hotel.address,
    nightlyRatesUsd: null,
    totalUsd: null,
    avgNightlyUsd: null,
    pointsPerNight: hotel.pointsPerNight,
    totalPoints: hotel.pointsPerNight * nights,
  })).sort((a, b) => a.totalPoints - b.totalPoints);
}

function reportLatencyBreach(context) {
  const {
    requestId, durationMs, budgetMs, callCount, concurrency, data,
  } = context;

  const error = new Error(`POST ${ROUTE} took ${durationMs}ms (budget ${budgetMs}ms)`);
  error.name = 'LatencyBudgetExceeded';

  Sentry.captureException(error, {
    level: 'warning',
    tags: {
      route: ROUTE,
      service: SERVICE,
      alert_path: 'latency',
      destination: data.destination,
      ratePreference: data.ratePreference,
    },
    extra: {
      requestId,
      durationMs,
      budgetMs,
      callCount,
      concurrency,
    },
  });

  createSessionAndAlert({
    issueTitle: `LatencyBudgetExceeded: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/ef51d258.js — quoteNightlyRates',
    errorType: 'LatencyBudgetExceeded',
    errorValue: error.message,
    devinUserId: data.devinUserId,
    devinEmail: data.devinEmail,
    devinOrgId: data.devinOrgId,
    service: SERVICE,
    verticalLabel: 'IHG Hotel Availability Search',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: 'ef51d258',
    slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'destination', value: data.destination },
      { key: 'rate_preference', value: data.ratePreference },
      { key: 'duration_ms', value: String(durationMs) },
    ],
    extra: {
      requestId,
      durationMs,
      budgetMs,
      callCount,
      concurrency,
    },
    level: 'warning',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for IHG search latency breach', {
      error: alertError.message,
      requestId,
    });
  });
}

async function searchAvailability(data) {
  const startTime = Date.now();
  const searchId = `IHG-${uuidv4().slice(0, 8).toUpperCase()}`;

  const normalized = {
    ...data,
    ratePreference: data.ratePreference || 'best_available',
    rooms: Number(data.rooms) > 0 ? Math.floor(Number(data.rooms)) : 1,
    adults: Number(data.adults) > 0 ? Math.floor(Number(data.adults)) : 1,
  };

  const { checkIn, checkOut, nights } = resolveStayDates(normalized);
  validateSearchRequest(normalized);

  const destination = DESTINATIONS[normalized.destination];
  const preference = RATE_PREFERENCES[normalized.ratePreference];

  logger.info('Searching IHG hotel availability', {
    searchId,
    destination: normalized.destination,
    checkIn,
    checkOut,
    nights,
    ratePreference: normalized.ratePreference,
    service: SERVICE,
    route: ROUTE,
  });

  const stayNights = [];
  for (let i = 0; i < nights; i++) {
    const date = new Date(`${checkIn}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + i);
    stayNights.push({ date: formatDate(date), dayOfWeek: date.getUTCDay() });
  }

  const isAward = normalized.ratePreference === 'points';
  const hotels = isAward
    ? await quoteAwardStays(destination.hotels, stayNights.length)
    : await quoteNightlyRates(destination.hotels, stayNights, preference.discount);

  const callCount = isAward ? 0 : destination.hotels.length * nights;
  const durationMs = Date.now() - startTime;

  incrementMetric('hotel_search.success', {
    route: ROUTE,
    destination: normalized.destination,
    ratePreference: normalized.ratePreference,
  });
  recordTiming('hotel_search.latency', durationMs, {
    route: ROUTE,
  });

  if (durationMs > LATENCY_SLO.budgetMs) {
    incrementMetric('hotel_search.latency_budget_breach', {
      route: ROUTE,
      destination: normalized.destination,
      ratePreference: normalized.ratePreference,
    });
    logger.warn('IHG hotel availability search exceeded latency budget', {
      searchId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      callCount,
      concurrency: RATE_QUOTE_POLICY.concurrency,
      hotels: destination.hotels.length,
      nights,
      service: SERVICE,
    });
    setImmediate(() => reportLatencyBreach({
      requestId: searchId,
      durationMs,
      budgetMs: LATENCY_SLO.budgetMs,
      callCount,
      concurrency: RATE_QUOTE_POLICY.concurrency,
      data: normalized,
    }));
  }

  return {
    success: true,
    searchId,
    destination: { key: normalized.destination, label: destination.label },
    checkIn,
    checkOut,
    nights,
    rooms: normalized.rooms,
    adults: normalized.adults,
    ratePreference: { key: normalized.ratePreference, label: preference.label },
    currency: 'USD',
    hotels,
    durationMs,
  };
}

module.exports = {
  searchAvailability,
  DESTINATIONS,
  RATE_PREFERENCES,
  RATE_QUOTE_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
};
