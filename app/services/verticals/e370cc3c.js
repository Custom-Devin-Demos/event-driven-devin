const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Nonstop routes bookable from the homepage flight search.
 */
const ROUTES = [
  {
    id: 'RT-SFO-JFK',
    origin: 'SFO',
    destination: 'JFK',
    distanceMiles: 2586,
    baseFare: 289.00,
    durationMinutes: 331,
    aircraft: 'A321neo',
  },
  {
    id: 'RT-SFO-ATL',
    origin: 'SFO',
    destination: 'ATL',
    distanceMiles: 2139,
    baseFare: 246.00,
    durationMinutes: 278,
    aircraft: 'B757-200',
  },
];

/**
 * Fare product configuration — drives seat selection, bag allowance,
 * and mileage accrual for each cabin offering.
 */
const FARE_PRODUCTS = {
  main_cabin: { cabinFactor: 1.0, checkedBags: 1, seatSelection: true, accrualEligible: true, accrualRate: 5 },
  comfort_plus: { cabinFactor: 1.35, checkedBags: 1, seatSelection: true, accrualEligible: false, extraLegroomInches: 3 },
};

function resolveRoute(origin, destination) {
  return ROUTES.find((r) => r.origin === origin && r.destination === destination) || ROUTES[0];
}

/**
 * Standard fare computation with carrier-imposed surcharges and taxes.
 */
function computeFareBreakdown(route, product, passengers) {
  const base = route.baseFare * product.cabinFactor * passengers;
  const carrierSurcharge = base * 0.062;
  const taxesAndFees = base * 0.075 + 5.60 * passengers;
  const total = base + carrierSurcharge + taxesAndFees;
  return {
    baseFare: Math.round(base * 100) / 100,
    carrierSurcharge: Math.round(carrierSurcharge * 100) / 100,
    taxesAndFees: Math.round(taxesAndFees * 100) / 100,
    total: Math.round(total * 100) / 100,
  };
}

/**
 * Build the bookable quote for a route and fare product: pricing,
 * seat/bag entitlements, and mileage accrual for eligible fares.
 */
function buildFlightQuote(route, product, fares, passengers) {
  const quote = {
    routeId: route.id,
    origin: route.origin,
    destination: route.destination,
    aircraft: route.aircraft,
    durationMinutes: route.durationMinutes,
    passengers,
    pricing: fares,
    entitlements: {
      checkedBags: product.checkedBags,
      seatSelection: product.seatSelection,
    },
  };

  if (product.accrualEligible) {
    const milesEarned = Math.round(route.distanceMiles * product.accrualRate * passengers);
    quote.accrual = {
      milesEarned,
      qualifyingDollars: Math.round(fares.baseFare),
    };
  }

  return quote;
}

/**
 * Assemble the customer-facing quote summary returned to the search widget.
 */
function summarizeQuote(quote, route) {
  const accrual = quote.accrual;

  return {
    routeId: quote.routeId,
    itinerary: `${quote.origin} \u2192 ${quote.destination}`,
    aircraft: quote.aircraft,
    durationMinutes: quote.durationMinutes,
    passengers: quote.passengers,
    totalFare: quote.pricing.total,
    baseFare: quote.pricing.baseFare,
    taxesAndFees: quote.pricing.taxesAndFees,
    checkedBags: quote.entitlements.checkedBags,
    accrualEligible: Boolean(accrual),
    milesEarned: accrual ? accrual.milesEarned : 0,
    qualifyingDollars: accrual ? accrual.qualifyingDollars : 0,
    distanceMiles: route.distanceMiles,
  };
}

/**
 * Processes a homepage flight quote request.
 */
async function processFlightQuote(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Building flight quote', {
    requestId,
    origin: data.origin,
    destination: data.destination,
    fareProduct: data.fareProduct,
    service: 'customer-e370cc3c-booking',
    route: '/api/e370cc3c/flight-quote',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 120));

    const route = resolveRoute(data.origin, data.destination);
    const product = FARE_PRODUCTS[data.fareProduct] || FARE_PRODUCTS.comfort_plus;
    const passengers = data.passengers || 1;
    const fares = computeFareBreakdown(route, product, passengers);
    const quote = buildFlightQuote(route, product, fares, passengers);
    const summary = summarizeQuote(quote, route);

    summary.requestId = requestId;
    summary.confirmationCode = `DL${String(Math.floor(Math.random() * 900000) + 100000)}`;
    summary.generatedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('flight_quote.success', {
      route: '/api/e370cc3c/flight-quote',
      fareProduct: data.fareProduct,
    });
    recordTiming('flight_quote.latency', duration, {
      route: '/api/e370cc3c/flight-quote',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('flight_quote.failure', {
      route: '/api/e370cc3c/flight-quote',
      errorClass: error.name,
    });
    recordTiming('flight_quote.latency', duration, {
      route: '/api/e370cc3c/flight-quote',
      error: 'true',
    });

    logger.error('Flight quote failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      origin: data.origin,
      destination: data.destination,
      fareProduct: data.fareProduct,
      service: 'customer-e370cc3c-booking',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/e370cc3c/flight-quote',
        service: 'customer-e370cc3c-booking',
        fareProduct: data.fareProduct,
      },
      extra: { requestId, origin: data.origin, destination: data.destination },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/e370cc3c.js \u2014 summarizeQuote',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-e370cc3c-booking',
      verticalLabel: 'Flight Quote',
      customer: 'e370cc3c',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/e370cc3c/flight-quote' },
        { key: 'service', value: 'customer-e370cc3c-booking' },
        { key: 'fareProduct', value: data.fareProduct },
      ],
      extra: { requestId, origin: data.origin, destination: data.destination },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-e370cc3c-booking@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for flight quote error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processFlightQuote, ROUTES, FARE_PRODUCTS };
