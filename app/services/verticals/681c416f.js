const logger = require('../../telemetry/logger');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Customer 681c416f — low-fare airline flight search.
 *
 * Models the shopping flow behind the homepage booking widget: pick a
 * city pair, price each fare product on every nonstop, then decorate the
 * result with Rapid Rewards earning so the fare card can show "Earn N pts".
 */

const AIRPORTS = {
  OAK: { city: 'Oakland', state: 'CA', tz: 'America/Los_Angeles' },
  LAS: { city: 'Las Vegas', state: 'NV', tz: 'America/Los_Angeles' },
  DEN: { city: 'Denver', state: 'CO', tz: 'America/Denver' },
  DAL: { city: 'Dallas (Love Field)', state: 'TX', tz: 'America/Chicago' },
  HOU: { city: 'Houston (Hobby)', state: 'TX', tz: 'America/Chicago' },
  MDW: { city: 'Chicago (Midway)', state: 'IL', tz: 'America/Chicago' },
  BWI: { city: 'Baltimore/Washington', state: 'MD', tz: 'America/New_York' },
  PHX: { city: 'Phoenix', state: 'AZ', tz: 'America/Phoenix' },
  MCO: { city: 'Orlando', state: 'FL', tz: 'America/New_York' },
  BNA: { city: 'Nashville', state: 'TN', tz: 'America/Chicago' },
};

const ROUTES = [
  { origin: 'OAK', destination: 'LAS', flightNumber: 'WN 1582', baseFare: 89, departs: '06:15', arrives: '07:45', durationMin: 90, aircraft: '737-800' },
  { origin: 'OAK', destination: 'LAS', flightNumber: 'WN 2210', baseFare: 104, departs: '11:40', arrives: '13:10', durationMin: 90, aircraft: '737 MAX 8' },
  { origin: 'OAK', destination: 'LAS', flightNumber: 'WN 3376', baseFare: 79, departs: '19:05', arrives: '20:35', durationMin: 90, aircraft: '737-700' },
  { origin: 'OAK', destination: 'DEN', flightNumber: 'WN 418', baseFare: 139, departs: '07:30', arrives: '11:05', durationMin: 155, aircraft: '737 MAX 8' },
  { origin: 'OAK', destination: 'PHX', flightNumber: 'WN 905', baseFare: 119, departs: '09:20', arrives: '11:15', durationMin: 115, aircraft: '737-800' },
  { origin: 'DAL', destination: 'HOU', flightNumber: 'WN 12', baseFare: 69, departs: '06:00', arrives: '07:05', durationMin: 65, aircraft: '737-700' },
  { origin: 'DAL', destination: 'HOU', flightNumber: 'WN 64', baseFare: 74, departs: '17:30', arrives: '18:35', durationMin: 65, aircraft: '737-700' },
  { origin: 'MDW', destination: 'BWI', flightNumber: 'WN 1121', baseFare: 129, departs: '08:10', arrives: '10:55', durationMin: 105, aircraft: '737-800' },
  { origin: 'MDW', destination: 'MCO', flightNumber: 'WN 2044', baseFare: 159, departs: '10:25', arrives: '14:10', durationMin: 165, aircraft: '737 MAX 8' },
  { origin: 'BNA', destination: 'DEN', flightNumber: 'WN 770', baseFare: 149, departs: '13:15', arrives: '14:55', durationMin: 160, aircraft: '737-800' },
];

/**
 * Fare products as sold on the booking path. `basic` is the default the
 * widget lands on because it is the lowest published fare.
 */
const FARE_PRODUCTS = {
  basic: {
    code: 'BSC',
    label: 'Basic',
    multiplier: 1.0,
    seatSelection: 'at check-in',
    changeFee: false,
    refundable: false,
    boardingGroup: 'C',
    checkedBags: 0,
  },
  choice: {
    code: 'CHO',
    label: 'Choice',
    multiplier: 1.35,
    seatSelection: 'standard seat included',
    changeFee: false,
    refundable: false,
    boardingGroup: 'B',
    checkedBags: 1,
  },
  choice_preferred: {
    code: 'CHP',
    label: 'Choice Preferred',
    multiplier: 1.8,
    seatSelection: 'preferred seat included',
    changeFee: false,
    refundable: true,
    boardingGroup: 'A',
    checkedBags: 1,
  },
  choice_extra: {
    code: 'CHX',
    label: 'Choice Extra',
    multiplier: 2.6,
    seatSelection: 'extra legroom seat included',
    changeFee: false,
    refundable: true,
    boardingGroup: 'A1-15',
    checkedBags: 2,
  },
};

/**
 * Rapid Rewards earning table, keyed by fare product code.
 *
 * Migrated from the legacy fare names (wanna_get_away, wanna_get_away_plus,
 * anytime, business_select) during the Choice fare rollout. The migration
 * job (LOY-4471) renamed the three Choice tiers in place; legacy
 * wanna_get_away rows were archived on the assumption that Basic would earn
 * under the WGA rate, but no `basic` row was ever re-inserted.
 */
const EARN_RATES = {
  choice: { pointsPerDollar: 8, tierQualifyingPoints: 800 },
  choice_preferred: { pointsPerDollar: 10, tierQualifyingPoints: 1000 },
  choice_extra: { pointsPerDollar: 12, tierQualifyingPoints: 1200 },
};

const TAXES_AND_FEES = {
  federalExciseTaxPct: 7.5,
  segmentFee: 5.2,
  passengerFacilityCharge: 4.5,
  securityFee: 5.6,
};

function priceFare(route, product, passengers) {
  const base = Math.round(route.baseFare * product.multiplier);
  const excise = Math.round(base * TAXES_AND_FEES.federalExciseTaxPct) / 100;
  const fees = TAXES_AND_FEES.segmentFee + TAXES_AND_FEES.passengerFacilityCharge + TAXES_AND_FEES.securityFee;
  const perPassenger = Math.round((base + excise + fees) * 100) / 100;
  return {
    baseFare: base,
    taxesAndFees: Math.round((excise + fees) * 100) / 100,
    perPassenger,
    total: Math.round(perPassenger * passengers * 100) / 100,
  };
}

function buildFareCard(route, fareProduct, passengers) {
  const product = FARE_PRODUCTS[fareProduct];
  const pricing = priceFare(route, product, passengers);
  const earn = EARN_RATES[fareProduct];
  const pointsEarned = Math.round(pricing.baseFare * earn.pointsPerDollar);

  return {
    flightNumber: route.flightNumber,
    departs: route.departs,
    arrives: route.arrives,
    durationMin: route.durationMin,
    aircraft: route.aircraft,
    fareProduct: product.label,
    fareCode: product.code,
    boardingGroup: product.boardingGroup,
    seatSelection: product.seatSelection,
    checkedBags: product.checkedBags,
    refundable: product.refundable,
    pricing,
    rapidRewards: {
      pointsEarned,
      tierQualifyingPoints: earn.tierQualifyingPoints,
    },
  };
}

function generateConfirmation() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let out = '';
  for (let i = 0; i < 6; i += 1) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

async function processFlightSearch(data) {
  const requestId = `SRCH-${Date.now().toString(36).toUpperCase()}`;

  try {
    const origin = String(data.origin || '').toUpperCase();
    const destination = String(data.destination || '').toUpperCase();
    const fareProduct = data.fareProduct || 'basic';
    const passengers = Math.max(1, Number(data.passengers) || 1);

    if (!AIRPORTS[origin] || !AIRPORTS[destination]) {
      const err = new Error(`Unknown airport code: ${!AIRPORTS[origin] ? origin : destination}`);
      err.code = 'INVALID_AIRPORT';
      throw err;
    }

    if (!FARE_PRODUCTS[fareProduct]) {
      const err = new Error(`Unknown fare product: ${fareProduct}`);
      err.code = 'INVALID_FARE_PRODUCT';
      throw err;
    }

    const nonstops = ROUTES.filter((r) => r.origin === origin && r.destination === destination);
    if (nonstops.length === 0) {
      const err = new Error(`No nonstop service ${origin}-${destination}`);
      err.code = 'NO_SERVICE';
      throw err;
    }

    logger.info('Pricing flight search', {
      requestId,
      origin,
      destination,
      fareProduct,
      passengers,
      nonstops: nonstops.length,
    });

    const flights = nonstops.map((route) => buildFareCard(route, fareProduct, passengers));
    const lowest = flights.reduce((a, b) => (b.pricing.total < a.pricing.total ? b : a));

    return {
      success: true,
      requestId,
      searchId: `${origin}${destination}-${generateConfirmation()}`,
      origin: { code: origin, ...AIRPORTS[origin] },
      destination: { code: destination, ...AIRPORTS[destination] },
      departureDate: data.departureDate || null,
      returnDate: data.returnDate || null,
      tripType: data.tripType || 'round-trip',
      passengers,
      fareProduct: FARE_PRODUCTS[fareProduct].label,
      flights,
      lowestFare: lowest.pricing.total,
      currency: 'USD',
    };
  } catch (error) {
    logger.error('Flight search failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      origin: data.origin,
      destination: data.destination,
      fareProduct: data.fareProduct,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/681c416f/search-flights',
        service: 'customer-681c416f-air-shopping',
        fareProduct: data.fareProduct || 'basic',
      },
      extra: {
        requestId,
        origin: data.origin,
        destination: data.destination,
        passengers: data.passengers,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/681c416f.js — buildFareCard',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-681c416f-air-shopping',
      verticalLabel: 'Flight Search',
      customer: '681c416f',
      tags: [
        { key: 'route', value: '/api/681c416f/search-flights' },
        { key: 'service', value: 'customer-681c416f-air-shopping' },
        { key: 'fareProduct', value: data.fareProduct || 'basic' },
        { key: 'market', value: `${data.origin || '?'}-${data.destination || '?'}` },
      ],
      extra: {
        requestId,
        origin: data.origin,
        destination: data.destination,
        passengers: data.passengers,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-681c416f-air-shopping@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for flight search error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  processFlightSearch,
  buildFareCard,
  AIRPORTS,
  ROUTES,
  FARE_PRODUCTS,
  EARN_RATES,
};
