const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Seating tier definitions with base pricing multipliers.
 */
const SEATING_TIERS = {
  orchestre: { label: 'Orchestre', multiplier: 1.0 },
  mezzanine: { label: 'Mezzanine', multiplier: 0.82 },
  balcon: { label: 'Balcon', multiplier: 0.65 },
};

/**
 * Paris venue catalog. Each venue has a type that determines
 * its seating configuration and capacity per tier.
 */
const VENUES = [
  { id: 'grand-theatre-lumiere', name: 'Grand Théâtre Lumière', type: 'theatre', district: '2e arrondissement', capacities: { orchestre: 620, mezzanine: 340, balcon: 210 } },
  { id: 'arena-bercy-est', name: 'Arena Bercy Est', type: 'arena', district: '12e arrondissement', capacities: { orchestre: 8200, mezzanine: 5400, balcon: 3100 } },
  { id: 'salle-des-augustins', name: 'Salle des Augustins', type: 'salle-historique', district: '6e arrondissement', capacities: { orchestre: 480, mezzanine: 260, balcon: 150 } },
  { id: 'caveau-jazz-rivoli', name: 'Caveau Jazz Rivoli', type: 'club', district: '1er arrondissement', capacities: { orchestre: 180, mezzanine: 90 } },
];

/**
 * Event catalog with base prices per event (EUR).
 */
const EVENTS = [
  { id: 'evt-2101', title: 'Nuit Symphonique — Ravel & Debussy', category: 'concert', venueId: 'grand-theatre-lumiere', date: '2026-07-18', time: '20:00', basePrice: 68 },
  { id: 'evt-2102', title: 'Électro Paris Festival — Soirée d\'ouverture', category: 'concert', venueId: 'arena-bercy-est', date: '2026-07-22', time: '21:00', basePrice: 89 },
  { id: 'evt-2103', title: 'Le Misanthrope — Comédie classique', category: 'theatre', venueId: 'salle-des-augustins', date: '2026-07-19', time: '19:30', basePrice: 52 },
  { id: 'evt-2104', title: 'Quartet Manouche — Hommage à Django', category: 'concert', venueId: 'caveau-jazz-rivoli', date: '2026-07-17', time: '21:30', basePrice: 38 },
  { id: 'evt-2105', title: 'Conférence — L\'IA et la création artistique', category: 'conference', venueId: 'salle-des-augustins', date: '2026-07-21', time: '18:00', basePrice: 29 },
];

function findEvent(eventId) {
  return EVENTS.find((e) => e.id === eventId) || EVENTS[0];
}

function findVenue(venueId) {
  return VENUES.find((v) => v.id === venueId);
}

/**
 * Build the live seating map for a venue. Reservation state is
 * simulated per request: each tier gets a capacity map holding
 * total seats, seats already sold, and remaining availability.
 */
function buildVenueSeating(venue) {
  const seating = {};

  for (const tierId of Object.keys(SEATING_TIERS)) {
    const total = venue.capacities[tierId];
    const tier = { tierId, label: SEATING_TIERS[tierId].label };

    if (total !== undefined) {
      const sold = Math.floor(total * (0.55 + Math.random() * 0.3));
      tier.capacity = { total, sold, remaining: total - sold };
    }

    seating[tierId] = tier;
  }

  return seating;
}

/**
 * Compute per-tier availability and pricing for an event.
 */
function computeAvailability(event, seating, tierId, quantity) {
  const tier = seating[tierId];
  const remaining = tier.capacity.remaining;

  if (remaining < quantity) {
    const err = new Error(`Only ${remaining} seats remaining in ${tier.label}`);
    err.code = 'INSUFFICIENT_AVAILABILITY';
    throw err;
  }

  const unitPrice = Math.round(event.basePrice * SEATING_TIERS[tierId].multiplier * 100) / 100;

  return {
    tierId,
    tierLabel: tier.label,
    remaining,
    unitPrice,
    quantity,
  };
}

/**
 * Assemble the final reservation summary returned to the client.
 */
function assembleReservation(event, venue, availability) {
  const subtotal = availability.unitPrice * availability.quantity;
  const bookingFee = Math.round(subtotal * 0.06 * 100) / 100;
  const total = Math.round((subtotal + bookingFee) * 100) / 100;

  return {
    reservationId: `SCN-${uuidv4().slice(0, 8).toUpperCase()}`,
    event: event.title,
    category: event.category,
    venue: venue.name,
    district: venue.district,
    date: event.date,
    time: event.time,
    tier: availability.tierLabel,
    quantity: availability.quantity,
    unitPrice: availability.unitPrice,
    subtotal: Math.round(subtotal * 100) / 100,
    bookingFee,
    total,
    currency: 'EUR',
  };
}

/**
 * Processes a seat reservation request.
 */
async function processReservation(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing seat reservation', {
    requestId,
    eventId: data.eventId,
    tier: data.tier,
    quantity: data.quantity,
    service: 'customer-efbf4b55-billetterie',
    route: '/api/efbf4b55/reserve',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const event = findEvent(data.eventId);
    const venue = findVenue(event.venueId);
    const seating = buildVenueSeating(venue);
    const availability = computeAvailability(event, seating, data.tier, data.quantity);
    const summary = assembleReservation(event, venue, availability);

    summary.requestId = requestId;
    summary.reservedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('seat_reservation.success', {
      route: '/api/efbf4b55/reserve',
      tier: data.tier,
    });
    recordTiming('seat_reservation.latency', duration, {
      route: '/api/efbf4b55/reserve',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('seat_reservation.failure', {
      route: '/api/efbf4b55/reserve',
      errorClass: error.name,
    });
    recordTiming('seat_reservation.latency', duration, {
      route: '/api/efbf4b55/reserve',
      error: 'true',
    });

    logger.error('Seat reservation failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      eventId: data.eventId,
      tier: data.tier,
      service: 'customer-efbf4b55-billetterie',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/efbf4b55/reserve',
        service: 'customer-efbf4b55-billetterie',
        tier: data.tier,
      },
      extra: { requestId, eventId: data.eventId, quantity: data.quantity },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/efbf4b55.js — computeAvailability',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-efbf4b55-billetterie',
      verticalLabel: 'Seat Reservation',
      customer: 'efbf4b55',
      tags: [
        { key: 'route', value: '/api/efbf4b55/reserve' },
        { key: 'service', value: 'customer-efbf4b55-billetterie' },
        { key: 'tier', value: data.tier },
      ],
      extra: { requestId, eventId: data.eventId, quantity: data.quantity },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-efbf4b55-billetterie@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for seat reservation error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processReservation, EVENTS, VENUES, SEATING_TIERS };
