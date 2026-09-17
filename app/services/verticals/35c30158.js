const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { RESORTS, RESORT_INVENTORY_SOURCES, fetchResortInventory } = require('./35c30158-inventory');
const { normalizeInventory } = require('./35c30158-normalize');

/**
 * 35c30158 — rental availability for the "Rent Now" booking widget.
 *
 * A guest picks a resort, pickup or delivery, and their dates; the service
 * pulls that resort's stock report, normalizes it, and returns the packages
 * available for the trip with a per-package quote.
 *
 * The inventory systems and stock reports here are a synthetic model built
 * for this demo; they do not describe the customer's real systems.
 */

const SLACK_MEMBER_ID = process.env.C35C30158_SLACK_MEMBER_ID || 'U08S7AVJ478';
const ROUTE = '/api/35c30158/availability';
const SERVICE = '35c30158-api';

const ACTIVITY_CATEGORIES = {
  snow: ['ski', 'snowboard'],
  bike: ['bike'],
};

const ADVANCE_BOOKING_DISCOUNT = 0.2;
const FULFILLMENT_OPTIONS = ['pickup', 'delivery'];
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the rental booking widget\'s "Rent Now" availability check:',
  '- Service: `app/services/verticals/35c30158.js`',
  '- Inventory sources: `app/services/verticals/35c30158-inventory.js`',
  '- Normalization: `app/services/verticals/35c30158-normalize.js`',
  '- Route: `app/routes/verticals/35c30158.js`',
  '- Page: `app/public/verticals/35c30158.html` (served at `/35c30158`)',
  '',
  'Guests checking rental availability for some resorts get an error instead of',
  'packages; other resorts return normally. The inventory systems in this code',
  'are a synthetic model for the demo, not a description of the customer\'s real',
  'systems.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function parseDate(value) {
  const match = typeof value === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === value ? date : null;
}

function validateRequest(data) {
  const resort = RESORTS.find((entry) => entry.id === data.resort);
  if (!resort) {
    throw validationError('Select a location to check availability.', 'RESORT_REQUIRED');
  }

  const activity = data.activity === undefined ? 'snow' : data.activity;
  if (!ACTIVITY_CATEGORIES[activity]) {
    throw validationError('Choose ski & snowboard or bike rentals.', 'ACTIVITY_INVALID');
  }
  const fulfillment = data.fulfillment === undefined ? 'pickup' : data.fulfillment;
  if (!FULFILLMENT_OPTIONS.includes(fulfillment)) {
    throw validationError('Choose pickup or delivery.', 'FULFILLMENT_INVALID');
  }
  if (fulfillment === 'delivery' && !resort.deliveryOffered) {
    throw validationError(`Rental delivery is not offered at ${resort.name}.`, 'DELIVERY_UNAVAILABLE');
  }

  const pickupDate = parseDate(data.pickupDate);
  const returnDate = parseDate(data.returnDate);
  if (!pickupDate || !returnDate) {
    throw validationError('Enter a pickup and return date.', 'DATES_REQUIRED');
  }
  if (daysUntil(pickupDate) < 0) {
    throw validationError('Pickup date cannot be in the past.', 'PICKUP_DATE_IN_PAST');
  }
  if (returnDate < pickupDate) {
    throw validationError('Return date must be on or after the pickup date.', 'DATE_RANGE_INVALID');
  }

  const rentalDays = Math.round((returnDate - pickupDate) / MS_PER_DAY) + 1;
  if (rentalDays > 14) {
    throw validationError('Rentals are limited to 14 days per reservation.', 'DATE_RANGE_TOO_LONG');
  }

  return { resort, activity, fulfillment, pickupDate, returnDate, rentalDays };
}

function daysUntil(date) {
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  return Math.round((date - today) / MS_PER_DAY);
}

function quoteOffer(offer, trip) {
  const listPrice = offer.dailyRate * trip.rentalDays;
  const advanceDiscount = daysUntil(trip.pickupDate) >= 2 ? listPrice * ADVANCE_BOOKING_DISCOUNT : 0;
  const total = listPrice - advanceDiscount;
  return {
    sku: offer.sku,
    name: offer.name,
    category: offer.category,
    level: offer.level,
    available: offer.available,
    inStock: offer.available > 0,
    dailyRate: offer.dailyRate,
    currency: offer.currency,
    rentalDays: trip.rentalDays,
    listPrice: Number(listPrice.toFixed(2)),
    advanceDiscount: Number(advanceDiscount.toFixed(2)),
    total: Number(total.toFixed(2)),
  };
}

function buildAvailability(offers, trip) {
  const categories = ACTIVITY_CATEGORIES[trip.activity];
  const packages = offers
    .filter((offer) => categories.includes(offer.category))
    .map((offer) => quoteOffer(offer, trip))
    .sort((a, b) => a.total - b.total);

  const inStock = packages.filter((pkg) => pkg.inStock);
  return {
    resort: { id: trip.resort.id, name: trip.resort.name, region: trip.resort.region },
    activity: trip.activity,
    fulfillment: trip.fulfillment,
    pickupDate: trip.pickupDate.toISOString().slice(0, 10),
    returnDate: trip.returnDate.toISOString().slice(0, 10),
    rentalDays: trip.rentalDays,
    packages,
    inStockCount: inStock.length,
    lowestTotal: inStock.length ? inStock[0].total : null,
  };
}

/**
 * Check rental availability for a trip.
 */
async function checkAvailability(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const trip = validateRequest(data);
  const source = RESORT_INVENTORY_SOURCES[trip.resort.id];

  logger.info('Checking rental availability', {
    requestId,
    resort: trip.resort.id,
    activity: trip.activity,
    fulfillment: trip.fulfillment,
    rentalDays: trip.rentalDays,
    inventorySystem: source.system,
    inventoryContract: source.contract,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const report = await fetchResortInventory(trip.resort.id);
    const offers = normalizeInventory(report.source, report.payload);
    const availability = buildAvailability(offers, trip);
    const duration = Date.now() - startTime;

    incrementMetric('35c30158.availability_checked', {
      route: ROUTE,
      resort: trip.resort.id,
      inventorySystem: source.system,
      activity: trip.activity,
    });
    recordTiming('35c30158.availability_latency', duration, {
      route: ROUTE,
      inventorySystem: source.system,
    });

    return { ...availability, requestId };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('35c30158.availability_failure', {
      route: ROUTE,
      resort: trip.resort.id,
      inventorySystem: source.system,
      errorClass: error.name,
    });
    recordTiming('35c30158.availability_latency', duration, {
      route: ROUTE,
      inventorySystem: source.system,
      error: 'true',
    });

    logger.error('Rental availability check failed', {
      requestId,
      resort: trip.resort.id,
      inventorySystem: source.system,
      inventoryContract: source.contract,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        resort: trip.resort.id,
        inventorySystem: source.system,
        alert_path: 'instant',
      },
      extra: {
        requestId,
        inventoryContract: source.contract,
        locationCode: source.locationCode,
        activity: trip.activity,
        fulfillment: trip.fulfillment,
        rentalDays: trip.rentalDays,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/35c30158-normalize.js \u2014 normalizeInventory',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Epic Mountain Rentals \u2014 Rental Availability',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '35c30158',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'resort', value: trip.resort.id },
        { key: 'inventorySystem', value: source.system },
        { key: 'inventoryContract', value: source.contract },
        { key: 'activity', value: trip.activity },
      ],
      extra: {
        requestId,
        resort: trip.resort.id,
        inventorySystem: source.system,
        inventoryContract: source.contract,
        locationCode: source.locationCode,
        activity: trip.activity,
        fulfillment: trip.fulfillment,
        pickupDate: trip.pickupDate.toISOString().slice(0, 10),
        returnDate: trip.returnDate.toISOString().slice(0, 10),
        rentalDays: trip.rentalDays,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '35c30158@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId });
    });

    throw error;
  }
}

module.exports = {
  checkAvailability,
  buildAvailability,
  REMEDIATION_DIRECTIVE,
  RESORTS,
};
