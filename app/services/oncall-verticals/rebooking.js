const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/rebooking/rebook';
const SERVICE = 'egencia-rebooking-api';

/** The disrupted trip the traveler is being rebooked on. */
const TRIP = {
  tripId: 'EGN-7F2K9Q',
  traveler: 'Julia Rhee',
  origin: 'CDG',
  destination: 'LHR',
  cancelledFlight: 'AF 1680',
  cancelledDeparture: '2026-10-16T07:25:00+02:00',
  policyCeiling: 320,
  currency: 'EUR',
};

/**
 * Alternatives offered on the disruption banner. `fare` is the new fare and
 * `fareDelta` the difference against the cancelled ticket (0 = free reissue).
 */
const ALTERNATIVES = {
  'AF1280': { id: 'AF1280', carrier: 'Air France', flight: 'AF 1280', departs: '09:55', arrives: '10:15', duration: '1h 20m', fare: 0, fareDelta: 0, cabin: 'Economy', seatsLeft: 4 },
  'BA0303': { id: 'BA0303', carrier: 'British Airways', flight: 'BA 0303', departs: '10:40', arrives: '11:00', duration: '1h 20m', fare: 46, fareDelta: 46, cabin: 'Economy', seatsLeft: 7 },
  'AF1080': { id: 'AF1080', carrier: 'Air France', flight: 'AF 1080', departs: '12:20', arrives: '12:40', duration: '1h 20m', fare: 0, fareDelta: 0, cabin: 'Economy', seatsLeft: 9 },
  'BA0309': { id: 'BA0309', carrier: 'British Airways', flight: 'BA 0309', departs: '14:15', arrives: '14:35', duration: '1h 20m', fare: 212, fareDelta: 212, cabin: 'Business', seatsLeft: 2 },
};

/**
 * Fare families the GDS is re-shopped for before a reissue is confirmed, so
 * the traveler is ticketed on the cheapest compliant fare. Each family is a
 * separate round trip to the airline through the GDS.
 */
const FARE_FAMILIES = ['LIGHT', 'STANDARD', 'FLEX', 'PREMIUM_ECONOMY', 'BUSINESS', 'BUSINESS_FLEX'];

const RESHOP_DEADLINE_MS = 8000;
const RESHOP_LATENCY_MS = [1250, 1550];
const SEAT_HOLD_MINUTES = 15;
const SEAT_HOLD_LATENCY_MS = [60, 140];

/** Hold one seat on a flight through the airline seat map (a single round trip). */
function holdSeat(flight, rebookId) {
  const [minMs, maxMs] = SEAT_HOLD_LATENCY_MS;
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        flight,
        holdRef: `HLD-${flight.replace(/\s/g, '')}-${rebookId.slice(-4)}`,
        expiresAt: new Date(Date.now() + SEAT_HOLD_MINUTES * 60000).toISOString(),
      });
    }, minMs + Math.random() * (maxMs - minMs));
  });
}

/** Re-shop one fare family for a flight through the GDS (one airline round trip). */
function reshopFareFamily(flight, family) {
  const [minMs, maxMs] = RESHOP_LATENCY_MS;
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ flight, family, available: family !== 'BUSINESS_FLEX', fareRef: `RS-${flight.replace(/\s/g, '')}-${family.slice(0, 3)}` });
    }, minMs + Math.random() * (maxMs - minMs));
  });
}

function invalidRequest(message) {
  const err = new Error(message);
  err.code = 'INVALID_REBOOK';
  return err;
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms`);
      err.code = 'RESHOP_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function resolveAlternative(alternativeId) {
  const key = typeof alternativeId === 'string' ? alternativeId.replace(/\s/g, '').toUpperCase() : '';
  const alt = Object.hasOwn(ALTERNATIVES, key) ? ALTERNATIVES[key] : null;
  if (!alt) throw invalidRequest(`Unknown alternative flight: ${alternativeId}`);
  return alt;
}

/**
 * Re-shop every fare family for the chosen flight before reissuing, so the
 * reissue is confirmed on the cheapest fare still open.
 */
async function reshopAlternative(alt, rebookId) {
  const quotes = [];
  for (const family of FARE_FAMILIES) {
    const startedAt = Date.now();
    const quote = await reshopFareFamily(alt.flight, family);
    logger.info('GDS re-shop', {
      rebookId,
      flight: alt.flight,
      fareFamily: family,
      durationMs: Date.now() - startedAt,
      service: SERVICE,
      endpoint: 'gds-reshop/v3/fare-families',
    });
    quotes.push(quote);
  }
  return quotes;
}

function policy(alt) {
  const inPolicy = alt.fare <= TRIP.policyCeiling && alt.cabin === 'Economy';
  return { inPolicy, ceiling: TRIP.policyCeiling, currency: TRIP.currency };
}

/**
 * Rebook the traveler onto an alternative (`action: 'rebook'`) or hold a seat
 * on it for 15 minutes (`action: 'hold'`). Rebooking re-shops the GDS before
 * the reissue; a hold is a single seat-map call.
 */
async function rebookFlight(data) {
  const startTime = Date.now();
  const rebookId = `RBK${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const action = data.action === 'hold' ? 'hold' : 'rebook';

  logger.info('Rebooking started', { rebookId, action, alternativeId: data.alternativeId, service: SERVICE, route: ROUTE });

  try {
    if (data.tripId !== undefined && data.tripId !== TRIP.tripId) throw invalidRequest(`Unknown trip: ${data.tripId}`);
    const alt = resolveAlternative(data.alternativeId);

    if (action === 'hold') {
      const startedAt = Date.now();
      const hold = await holdSeat(alt.flight, rebookId);
      logger.info('Seat hold', {
        rebookId, flight: alt.flight, holdRef: hold.holdRef, durationMs: Date.now() - startedAt, service: SERVICE, endpoint: 'seat-map/v2/hold',
      });
      incrementMetric('rebooking.hold.success', { route: ROUTE });
      recordTiming('rebooking.hold.latency', Date.now() - startTime, { route: ROUTE, service: SERVICE });
      return {
        success: true,
        action,
        rebookId,
        tripId: TRIP.tripId,
        flight: alt.flight,
        carrier: alt.carrier,
        holdRef: hold.holdRef,
        holdMinutes: SEAT_HOLD_MINUTES,
        expiresAt: hold.expiresAt,
        policy: policy(alt),
      };
    }

    const quotes = await withDeadline(reshopAlternative(alt, rebookId), RESHOP_DEADLINE_MS, 'GDS re-shop');
    const confirmedFamily = quotes.find((q) => q.available).family;

    incrementMetric('rebooking.rebook.success', { route: ROUTE });
    recordTiming('rebooking.rebook.latency', Date.now() - startTime, { route: ROUTE, service: SERVICE });

    return {
      success: true,
      action,
      rebookId,
      tripId: TRIP.tripId,
      pnr: `${alt.id.slice(0, 2)}${rebookId.slice(-4)}`,
      flight: alt.flight,
      carrier: alt.carrier,
      departs: alt.departs,
      arrives: alt.arrives,
      fareFamily: confirmedFamily,
      fareDelta: alt.fareDelta,
      currency: TRIP.currency,
      policy: policy(alt),
      ticketedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric(`rebooking.${action}.failure`, { route: ROUTE, errorClass: error.name });
    recordTiming(`rebooking.${action}.latency`, duration, { route: ROUTE, service: SERVICE, error: 'true' });
    logger.error('Rebooking failed', {
      rebookId, action, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, alternativeId: data.alternativeId,
    });
    if (error.code !== 'INVALID_REBOOK') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE, action },
        extra: { rebookId, alternativeId: data.alternativeId },
      });
    }
    throw error;
  }
}

module.exports = { rebookFlight, TRIP, ALTERNATIVES, FARE_FAMILIES, RESHOP_DEADLINE_MS, SEAT_HOLD_MINUTES };
