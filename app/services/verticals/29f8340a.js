const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-29f8340a-tickets';
const ROUTE = '/api/29f8340a/tickets';

/**
 * Demo owner pinned for this vertical: alerts and Devin sessions always land
 * with this user in the customer org, regardless of what the page sends.
 */
const OWNER = Object.freeze({
  slackMemberId: 'U08S7AVJ478',
  devinUserId: 'clerk-user_2eG9PmvFhmV7fNu7TNuSRGeGPpV',
  devinOrgId: 'org-ed3f47f7577c4ec0bbb3c29f2148bb3c',
});

/**
 * STACK Conference 2026 pass catalogue, keyed by the pass code printed on the
 * ticketing links. Each pass carries the pricing, access and fulfilment rules
 * the reservation is built from.
 */
const PASS_CATALOGUE = {
  'stack26-early-bird': {
    code: 'stack26-early-bird',
    label: 'Early bird pass',
    pricing: { amountCents: 24900, currency: 'SGD', gstInclusive: true },
    access: { days: ['2026-11-04', '2026-11-05'], tracks: ['keynote', 'breakout', 'expo'], workshops: 0 },
    fulfilment: { channel: 'e-ticket', transferable: true, cutoff: '2026-09-30T15:59:59Z' },
  },
  'stack26-standard': {
    code: 'stack26-standard',
    label: 'Standard pass',
    pricing: { amountCents: 34900, currency: 'SGD', gstInclusive: true },
    access: { days: ['2026-11-04', '2026-11-05'], tracks: ['keynote', 'breakout', 'expo'], workshops: 0 },
    fulfilment: { channel: 'e-ticket', transferable: true, cutoff: '2026-11-03T15:59:59Z' },
  },
  'stack26-workshop-addon': {
    code: 'stack26-workshop-addon',
    label: 'Workshop add-on',
    pricing: { amountCents: 9900, currency: 'SGD', gstInclusive: true },
    access: { days: ['2026-11-06'], tracks: ['workshop'], workshops: 1 },
    fulfilment: { channel: 'e-ticket', transferable: false, cutoff: '2026-11-03T15:59:59Z' },
  },
};

/**
 * Attendee categories and the discount applied on top of the pass price.
 */
const ATTENDEE_TYPES = {
  public: { label: 'Public', discountPct: 0 },
  'public-officer': { label: 'Public officer', discountPct: 100 },
  student: { label: 'Student', discountPct: 50 },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 */
const REMEDIATION_DIRECTIVE = [
  'Reproduce the failure by starting the app (node app/server.js), opening /29f8340a and clicking any link or button on the page;',
  'every click submits a STACK Conference ticket reservation and currently fails with a TypeError.',
  'Trace the pass code the route sends into the service and the catalogue the service resolves it against, make the reservation succeed end to end,',
  'and add a regression test under tests/ that locks the fix in. Open a pull request against main.',
].join(' ');

class UnknownPassCodeError extends Error {
  constructor(passCode) {
    super(`Unknown STACK Conference pass code: ${String(passCode)}`);
    this.name = 'UnknownPassCodeError';
    this.code = 'UNKNOWN_PASS_CODE';
    this.statusCode = 422;
  }
}

/**
 * Pass codes arrive in several spellings (STACK26-EARLYBIRD on the ticketing
 * links, stack26-early-bird in the catalogue), so compare them ignoring case
 * and separators.
 */
function normalisePassCode(code) {
  if (typeof code !== 'string') return '';
  const normalised = code.trim().toLowerCase().replace(/[\s_-]+/g, '');
  return /^[a-z0-9]+$/.test(normalised) ? normalised : '';
}

const PASS_INDEX = new Map(
  Object.values(PASS_CATALOGUE).map((pass) => [normalisePassCode(pass.code), pass]),
);

function resolvePass(code) {
  const pass = PASS_INDEX.get(normalisePassCode(code));
  if (!pass) throw new UnknownPassCodeError(code);
  return pass;
}

function resolveAttendeeType(type) {
  const key = typeof type === 'string' ? type.trim().toLowerCase() : '';
  return ATTENDEE_TYPES[key] || ATTENDEE_TYPES.public;
}

function buildPricing(pass, attendee, quantity) {
  const unit = pass.pricing.amountCents;
  const discounted = Math.round(unit * (1 - attendee.discountPct / 100));
  return {
    currency: pass.pricing.currency,
    gstInclusive: pass.pricing.gstInclusive,
    unitAmountCents: unit,
    discountPct: attendee.discountPct,
    quantity,
    totalAmountCents: discounted * quantity,
  };
}

function buildAccess(pass) {
  return {
    days: [...pass.access.days],
    tracks: [...pass.access.tracks],
    workshopCredits: pass.access.workshops,
    badgeId: uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase(),
  };
}

function buildReservation(order, pass, attendee) {
  return {
    orderId: order.orderId,
    passCode: pass.code,
    passLabel: pass.label,
    attendeeType: attendee.label,
    pricing: buildPricing(pass, attendee, order.quantity),
    access: buildAccess(pass),
    fulfilment: {
      channel: pass.fulfilment.channel,
      transferable: pass.fulfilment.transferable,
      holdUntil: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      cutoff: pass.fulfilment.cutoff,
    },
    checkoutUrl: `https://go.gov.sg/stack26-checkout/${order.orderId}`,
  };
}

/**
 * Reserve STACK Conference passes: resolve the requested pass and attendee
 * type, price the order and hold the seats for checkout.
 *
 * @param {object} data
 * @param {string} data.action - label of the control that triggered the reservation
 * @param {string} data.passCode - pass code identifier
 * @param {string} data.attendeeType - attendee category
 * @param {number} data.quantity - number of passes
 */
async function reserveTickets(data) {
  const start = Date.now();
  const referenceNumber = `STK-${uuidv4().slice(0, 8).toUpperCase()}`;
  const order = {
    orderId: uuidv4().replace(/-/g, '').slice(0, 20),
    quantity: Number.isInteger(data.quantity) && data.quantity > 0 ? data.quantity : 1,
  };

  logger.info('Ticket reservation requested', {
    referenceNumber,
    action: data.action,
    passCode: data.passCode,
    attendeeType: data.attendeeType,
    quantity: order.quantity,
    service: SERVICE,
  });

  try {
    const pass = resolvePass(data.passCode);
    const attendee = resolveAttendeeType(data.attendeeType);
    const reservation = buildReservation(order, pass, attendee);
    const duration = Date.now() - start;

    incrementMetric('ticket_reservation.success', { route: ROUTE, passCode: reservation.passCode });
    recordTiming('ticket_reservation.latency', duration, { route: ROUTE });

    logger.info('Tickets reserved', {
      referenceNumber,
      orderId: reservation.orderId,
      passCode: reservation.passCode,
      totalAmountCents: reservation.pricing.totalAmountCents,
      durationMs: duration,
      service: SERVICE,
    });

    return { success: true, referenceNumber, reservation };
  } catch (error) {
    const duration = Date.now() - start;

    incrementMetric('ticket_reservation.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('ticket_reservation.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Ticket reservation failed', {
      referenceNumber,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      action: data.action,
      passCode: data.passCode,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        alert_path: 'instant',
        passCode: String(data.passCode),
      },
      extra: { referenceNumber, action: data.action, orderId: order.orderId },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/29f8340a.js \u2014 buildReservation',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: OWNER.devinUserId,
      devinOrgId: OWNER.devinOrgId,
      service: SERVICE,
      verticalLabel: 'STACK Conference Ticketing',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '29f8340a',
      slackMemberId: OWNER.slackMemberId,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'alert_path', value: 'instant' },
        { key: 'passCode', value: String(data.passCode) },
        { key: 'action', value: String(data.action || '') },
      ],
      extra: { referenceNumber, action: data.action, orderId: order.orderId },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
      environment: process.env.NODE_ENV || 'production',
      triggeredRule: 'Ticket reservation failure (instant)',
    }).catch((alertError) => {
      logger.error('Failed to raise ticket reservation alert', { referenceNumber, error: alertError.message });
    });

    throw error;
  }
}

module.exports = {
  reserveTickets,
  resolvePass,
  normalisePassCode,
  UnknownPassCodeError,
  resolveAttendeeType,
  buildReservation,
  PASS_CATALOGUE,
  ATTENDEE_TYPES,
  OWNER,
  REMEDIATION_DIRECTIVE,
  SERVICE,
  ROUTE,
};
