const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Fare class configuration for each cabin type.
 */
const FARE_CLASSES = {
  economy: { code: 'Y', multiplier: 1.0, bags: 0, seatPitch: 31 },
  premium_economy: { code: 'W', multiplier: 1.75, bags: 1, seatPitch: 35, loyalty: { milesMultiplier: 1.5, tierBonus: 500 } },
  business: { code: 'J', multiplier: 3.2, bags: 2, seatPitch: 42, loyalty: { milesMultiplier: 2.0, tierBonus: 1000 } },
  first: { code: 'F', multiplier: 5.0, bags: 3, seatPitch: 60, loyalty: { milesMultiplier: 3.0, tierBonus: 2000 } },
};

/**
 * Route inventory with base fares and availability.
 */
const ROUTES = [
  { origin: 'EWR', destination: 'LAX', baseFare: 289, flightNumber: 'UA 1524', duration: 345, aircraft: '737 MAX 9' },
  { origin: 'EWR', destination: 'SFO', baseFare: 312, flightNumber: 'UA 2201', duration: 360, aircraft: '787-9 Dreamliner' },
  { origin: 'ORD', destination: 'DEN', baseFare: 198, flightNumber: 'UA 738', duration: 195, aircraft: '737-800' },
  { origin: 'IAH', destination: 'MIA', baseFare: 224, flightNumber: 'UA 1932', duration: 165, aircraft: 'A321neo' },
  { origin: 'SFO', destination: 'NRT', baseFare: 895, flightNumber: 'UA 837', duration: 660, aircraft: '777-300ER' },
];

/**
 * Ancillary products available during booking.
 */
const ANCILLARIES = [
  { id: 'seat-select', label: 'Seat Selection', price: 35 },
  { id: 'extra-bag', label: 'Extra Checked Bag', price: 40 },
  { id: 'wifi', label: 'Wi-Fi Pass', price: 12 },
  { id: 'lounge', label: 'United Club One-Time Pass', price: 59 },
];

function findRoute(origin, destination) {
  return ROUTES.find((r) => r.origin === origin && r.destination === destination) || ROUTES[0];
}

/**
 * Compute the fare breakdown for a given route and cabin.
 */
function computeFareBreakdown(route, cabin, passengers) {
  const fareClass = FARE_CLASSES[cabin] || FARE_CLASSES.economy;
  const baseFare = route.baseFare * fareClass.multiplier;
  const taxes = baseFare * 0.075;
  const segmentFee = 4.50 * passengers;
  const facilityCharge = 4.50;
  const securityFee = 5.60 * passengers;

  return {
    baseFare: Math.round(baseFare * 100) / 100,
    taxes: Math.round(taxes * 100) / 100,
    segmentFee,
    facilityCharge,
    securityFee,
    fareCode: fareClass.code,
    includedBags: fareClass.bags,
  };
}

/**
 * Build the itinerary summary for display.
 */
function buildItinerary(route, fareBreakdown, passengers) {
  const perPassenger = fareBreakdown.baseFare
    + fareBreakdown.taxes
    + fareBreakdown.segmentFee / passengers
    + fareBreakdown.facilityCharge / passengers
    + fareBreakdown.securityFee / passengers;

  const milesEarned = Math.round(route.duration * fareBreakdown.loyalty.milesMultiplier);

  return {
    flight: route.flightNumber,
    origin: route.origin,
    destination: route.destination,
    aircraft: route.aircraft,
    durationMinutes: route.duration,
    fareCode: fareBreakdown.fareCode,
    perPassenger: Math.round(perPassenger * 100) / 100,
    includedBags: fareBreakdown.includedBags,
    milesEarned,
    tierBonus: fareBreakdown.loyalty.tierBonus,
  };
}

/**
 * Assemble the final pricing summary shown to the customer.
 */
function assemblePricingSummary(itinerary, fareBreakdown, passengers, ancillaries) {
  const ancillaryTotal = ancillaries.reduce((sum, a) => sum + a.price, 0);
  const subtotal = itinerary.perPassenger * passengers;
  const total = subtotal + ancillaryTotal;

  return {
    flight: itinerary.flight,
    route: `${itinerary.origin} \u2192 ${itinerary.destination}`,
    aircraft: itinerary.aircraft,
    duration: `${Math.floor(itinerary.durationMinutes / 60)}h ${itinerary.durationMinutes % 60}m`,
    fareCode: itinerary.fareCode,
    perPassenger: itinerary.perPassenger,
    passengers: passengers,
    subtotal: Math.round(subtotal * 100) / 100,
    ancillaries: ancillaries.map((a) => ({ label: a.label, price: a.price })),
    ancillaryTotal: ancillaryTotal,
    total: Math.round(total * 100) / 100,
    milesEarned: itinerary.milesEarned,
  };
}

/**
 * Processes a flight search request.
 */
async function processFlightSearch(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing flight search', {
    requestId,
    origin: data.origin,
    destination: data.destination,
    service: 'customer-4ada28b9-flights',
    route: '/api/4ada28b9/search-flights',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const route = findRoute(data.origin, data.destination);
    const fareBreakdown = computeFareBreakdown(route, data.cabin, data.passengers);
    const itinerary = buildItinerary(route, fareBreakdown, data.passengers);
    const selectedAncillaries = (data.ancillaries || [])
      .map((id) => ANCILLARIES.find((a) => a.id === id))
      .filter(Boolean);
    const summary = assemblePricingSummary(itinerary, fareBreakdown, data.passengers, selectedAncillaries);

    summary.requestId = requestId;
    summary.searchedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('flight_search.success', {
      route: '/api/4ada28b9/search-flights',
      cabin: data.cabin,
    });
    recordTiming('flight_search.latency', duration, {
      route: '/api/4ada28b9/search-flights',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('flight_search.failure', {
      route: '/api/4ada28b9/search-flights',
      errorClass: error.name,
    });
    recordTiming('flight_search.latency', duration, {
      route: '/api/4ada28b9/search-flights',
      error: 'true',
    });

    logger.error('Flight search failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      origin: data.origin,
      destination: data.destination,
      service: 'customer-4ada28b9-flights',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/4ada28b9/search-flights',
        service: 'customer-4ada28b9-flights',
        cabin: data.cabin,
      },
      extra: { requestId, origin: data.origin, destination: data.destination },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/4ada28b9.js \u2014 buildItinerary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-4ada28b9-flights',
      verticalLabel: 'Flight Search',
      customer: '4ada28b9',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/4ada28b9/search-flights' },
        { key: 'service', value: 'customer-4ada28b9-flights' },
        { key: 'cabin', value: data.cabin },
      ],
      extra: { requestId, origin: data.origin, destination: data.destination },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-4ada28b9-flights@1.0.0',
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

module.exports = { processFlightSearch, ROUTES, FARE_CLASSES, ANCILLARIES };
