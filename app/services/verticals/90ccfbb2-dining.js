const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { postOncallAlert } = require('../oncall');
const { declareDatadogIncident } = require('../datadog-incidents');
const { callInventory, inventoryError } = require('./90ccfbb2');

/**
 * Disney Dining reservations (/90ccfbb2/dining) — the dining-reservations
 * consumer of the shared resort-inventory platform. Tickets & Resort Hotels
 * (/90ccfbb2/tickets) is the other consumer of the same availability API.
 *
 * Provider contract this consumer was built against (GET /api/availability):
 *   { productId, days: [{ date, status: 'AVAILABLE'|'LIMITED'|'SOLD_OUT', priceFromUsd: number }] }
 */

const SERVICE = 'dining-reservations';
const ALERT_SLUG = '90ccfbb2-dining';
const RESTAURANT_RE = /^(wdw|dlr)-[a-z]{2,4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{1,2}:\d{2} (AM|PM)$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;
const NO_SHOW_FEE_PER_GUEST = 10;
const ALERT_COOLDOWN_MS = () => Number(process.env.DINING_ALERT_COOLDOWN_MS) || 10 * 60 * 1000;
const lastAlertAt = new Map();

function validate({ restaurantId, date }) {
  if (!RESTAURANT_RE.test(restaurantId || '')) throw inventoryError(400, 'INVALID_RESTAURANT', 'Unknown restaurant');
  if (!DATE_RE.test(date || '')) throw inventoryError(400, 'INVALID_DATE', 'Dates must be YYYY-MM-DD');
}

async function offerFor(restaurantId, date) {
  const result = await callInventory('get', '/api/availability', { params: { productId: restaurantId, from: date, days: 1 } });
  const offer = (result.days || [])[0];
  if (!offer) throw inventoryError(404, 'NO_OFFER', 'No dining availability for that date');
  return offer;
}

async function getDiningAvailability({ restaurantId, date }) {
  validate({ restaurantId, date });
  const offer = await offerFor(restaurantId, date);
  return { restaurantId, date, status: offer.status };
}

/** Estimated check and credit-card guarantee shown on the confirmation. */
function quoteReservation(offer, partySize) {
  const perAdult = Number(offer.priceFromUsd.toFixed(2));
  return {
    perAdult,
    estimatedTotal: Number((perAdult * partySize).toFixed(2)),
    noShowFee: NO_SHOW_FEE_PER_GUEST * partySize,
  };
}

function raiseAlert(error, { restaurantId, date, partySize, devinEmail }) {
  const reference = `DIN-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
  incrementMetric('dining_reservations.booking_failure', { restaurantId, service: SERVICE });
  logger.error('Book Reservation failed', {
    reference, restaurantId, date, partySize, error: error.message, service: SERVICE,
  });
  Sentry.captureException(error, {
    tags: { route: '/api/90ccfbb2/dining/reservations', service: SERVICE, restaurantId, alert_path: 'instant' },
    extra: { reference, date, partySize },
  });
  const signature = `${restaurantId}|${error.message}`;
  if (Date.now() - (lastAlertAt.get(signature) || 0) >= ALERT_COOLDOWN_MS()) {
    lastAlertAt.set(signature, Date.now());
    const email = EMAIL_RE.test(devinEmail || '') ? devinEmail : undefined;
    declareDatadogIncident({
      title: 'Disney Dining: Book Reservation failing',
      summary: `POST /api/90ccfbb2/dining/reservations returns 500 (${error.name}: ${error.message}) for ${restaurantId} on ${date}.`,
      runRef: reference,
      service: SERVICE,
      triggeredBy: email || 'dining-reservations-oncall',
      repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
      severity: 'SEV-2',
    }).catch((ddError) => logger.warn('Failed to declare Datadog incident for dining reservations', { error: ddError.message, reference }));
    postOncallAlert(ALERT_SLUG, { runRef: reference, devinEmail: email })
      .then((alert) => logger.info('Posting alert and triggering Devin', { reference, ok: alert && alert.ok, service: SERVICE }))
      .catch((alertError) => logger.warn('Dining reservations on-call alert failed', { error: alertError.message, reference }));
  }
  return reference;
}

async function createReservation({ restaurantId, date, time, partySize, devinEmail }) {
  validate({ restaurantId, date });
  if (!TIME_RE.test(time || '')) throw inventoryError(400, 'INVALID_TIME', 'Choose a seating time');
  const party = Number(partySize);
  if (!Number.isInteger(party) || party < 1 || party > 10) throw inventoryError(400, 'INVALID_PARTY', 'Party size must be 1-10');

  const offer = await offerFor(restaurantId, date);
  if (offer.status === 'SOLD_OUT') throw inventoryError(409, 'NO_TABLES', 'No tables are available for that date');

  let quote;
  try {
    quote = quoteReservation(offer, party);
  } catch (error) {
    const reference = raiseAlert(error, { restaurantId, date, partySize: party, devinEmail });
    const failure = inventoryError(500, 'RESERVATION_FAILED', 'We are unable to complete your dining reservation right now.');
    failure.reference = reference;
    failure.detail = `${error.name}: ${error.message}`;
    throw failure;
  }

  const hold = await callInventory('post', '/api/holds', { data: { productId: restaurantId, date, quantity: party } });
  const sale = await callInventory('post', '/api/checkout', { data: { holdId: hold.id } });
  return {
    confirmation: sale.confirmation,
    restaurantId,
    date,
    time,
    partySize: party,
    ...quote,
  };
}

module.exports = { getDiningAvailability, createReservation, quoteReservation };
