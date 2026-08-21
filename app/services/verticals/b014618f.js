const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Rewards cards that can pay for a Capital One Travel booking with miles.
 */
const CARD_PRODUCTS = [
  {
    code: 'venture-x',
    name: 'Venture X Rewards',
    network: 'Visa Infinite',
    annualFee: 395,
    rewardsProgram: 'venture_x_premium',
    travelCreditUsd: 300,
  },
  {
    code: 'venture',
    name: 'Venture Rewards',
    network: 'Visa Signature',
    annualFee: 95,
    rewardsProgram: 'venture_core',
    travelCreditUsd: 0,
  },
  {
    code: 'savorone',
    name: 'SavorOne Rewards',
    network: 'Mastercard World Elite',
    annualFee: 0,
    rewardsProgram: 'savor_cash',
    travelCreditUsd: 0,
  },
];

/**
 * Redemption economics for each rewards program. The program code is the join
 * key between a card product and the value of a mile at the Capital One Travel
 * checkout, so every product's `rewardsProgram` must be registered here.
 */
const REDEMPTION_PROGRAMS = {
  venture_core: {
    label: 'Venture Rewards',
    centsPerMile: 1,
    minimumMiles: 2500,
    milesIncrement: 100,
    anniversaryBonusMiles: 0,
  },
  savor_cash: {
    label: 'SavorOne Rewards',
    centsPerMile: 1,
    minimumMiles: 2000,
    milesIncrement: 100,
    anniversaryBonusMiles: 0,
  },
};

/**
 * Booking types bookable through the Capital One Travel portal, with the
 * earn multiplier applied to the portion of the trip paid with the card.
 */
const BOOKING_TYPES = {
  hotel: { label: 'Hotel', earnMultiplier: 10 },
  car: { label: 'Rental car', earnMultiplier: 10 },
  flight: { label: 'Flight', earnMultiplier: 5 },
};

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Capital One Travel miles-redemption vertical:',
  '- Service: `app/services/verticals/b014618f.js`',
  '- Route: `app/routes/verticals/b014618f.js`',
  '- Page: `app/public/verticals/b014618f.html` (served at `/capitalone`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function findCardProduct(cardProduct) {
  return CARD_PRODUCTS.find((card) => card.code === cardProduct) || CARD_PRODUCTS[0];
}

/**
 * Round the requested miles down to the program's redemption increment.
 */
function normalizeMilesApplied(requestedMiles, program) {
  const increment = program.milesIncrement;
  return Math.floor(requestedMiles / increment) * increment;
}

/**
 * Price the miles the traveler is applying to the booking and return the
 * remaining balance charged to the card.
 */
function buildRedemption(card, tripTotalUsd, requestedMiles) {
  const program = REDEMPTION_PROGRAMS[card.rewardsProgram];

  const milesApplied = normalizeMilesApplied(requestedMiles, program);
  const milesValueUsd = Number(((milesApplied * program.centsPerMile) / 100).toFixed(2));
  const cappedValueUsd = Math.min(milesValueUsd, tripTotalUsd);
  const remainingUsd = Number((tripTotalUsd - cappedValueUsd).toFixed(2));

  return {
    program: program.label,
    centsPerMile: program.centsPerMile,
    minimumMiles: program.minimumMiles,
    milesApplied,
    milesValueUsd: cappedValueUsd,
    remainingChargeUsd: remainingUsd,
  };
}

/**
 * Miles earned on the portion of the trip still charged to the card.
 */
function buildEarnEstimate(bookingType, remainingChargeUsd) {
  const booking = BOOKING_TYPES[bookingType] || BOOKING_TYPES.hotel;
  return {
    bookingType: booking.label,
    earnMultiplier: booking.earnMultiplier,
    estimatedMilesEarned: Math.round(remainingChargeUsd * booking.earnMultiplier),
  };
}

/**
 * Assemble the confirmation returned to the traveler.
 */
function buildBookingResult(bookingId, card, redemption, earn, itinerary) {
  return {
    bookingId,
    status: 'confirmed',
    card: {
      code: card.code,
      name: card.name,
      network: card.network,
    },
    itinerary,
    redemption,
    earn,
    travelCreditRemainingUsd: card.travelCreditUsd,
    confirmationEmailQueued: true,
  };
}

/**
 * Applies miles to a Capital One Travel booking and charges the remainder.
 */
async function redeemMiles(data) {
  const startTime = Date.now();
  const bookingId = uuidv4();

  const tripTotalUsd = Number(data.tripTotalUsd);
  const requestedMiles = Number(data.milesApplied);

  if (!Number.isFinite(tripTotalUsd) || tripTotalUsd <= 0 || !Number.isFinite(requestedMiles) || requestedMiles <= 0) {
    const validationError = new Error('Enter a trip total and the number of miles you want to apply.');
    validationError.name = 'ValidationError';
    validationError.code = 'INVALID_REDEMPTION_REQUEST';
    validationError.statusCode = 400;
    throw validationError;
  }

  logger.info('Applying miles to travel booking', {
    bookingId,
    cardProduct: data.cardProduct,
    bookingType: data.bookingType,
    service: 'customer-b014618f-travel-redemption',
    route: '/api/b014618f/redeem-miles',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const card = findCardProduct(data.cardProduct);
    const redemption = buildRedemption(card, tripTotalUsd, requestedMiles);
    const earn = buildEarnEstimate(data.bookingType, redemption.remainingChargeUsd);
    const result = buildBookingResult(bookingId, card, redemption, earn, {
      type: (BOOKING_TYPES[data.bookingType] || BOOKING_TYPES.hotel).label,
      property: data.property || 'The Bowery Hotel — New York, NY',
      checkIn: data.checkIn || '2026-09-18',
      checkOut: data.checkOut || '2026-09-21',
      tripTotalUsd,
    });

    const duration = Date.now() - startTime;

    incrementMetric('travel_redemption.booking_success', {
      route: '/api/b014618f/redeem-miles',
      card: card.code,
      bookingType: data.bookingType || 'hotel',
    });
    recordTiming('travel_redemption.booking_latency', duration, {
      route: '/api/b014618f/redeem-miles',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('travel_redemption.booking_failure', {
      route: '/api/b014618f/redeem-miles',
      errorClass: error.name,
      card: data.cardProduct,
    });
    recordTiming('travel_redemption.booking_latency', duration, {
      route: '/api/b014618f/redeem-miles',
      error: 'true',
    });

    logger.error('Miles redemption failed', {
      bookingId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      cardProduct: data.cardProduct,
      bookingType: data.bookingType,
      service: 'customer-b014618f-travel-redemption',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/b014618f/redeem-miles',
        service: 'customer-b014618f-travel-redemption',
        card: data.cardProduct,
      },
      extra: {
        bookingId,
        bookingType: data.bookingType,
        milesApplied: data.milesApplied,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b014618f.js \u2014 buildRedemption',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-b014618f-travel-redemption',
      verticalLabel: 'Travel Rewards Redemption',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'b014618f',
      slackMemberId: 'U0BKV8PTK6F',
      tags: [
        { key: 'route', value: '/api/b014618f/redeem-miles' },
        { key: 'service', value: 'customer-b014618f-travel-redemption' },
        { key: 'card', value: data.cardProduct },
        { key: 'bookingType', value: data.bookingType },
      ],
      extra: {
        bookingId,
        bookingType: data.bookingType,
        milesApplied: data.milesApplied,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-b014618f-travel-redemption@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for travel redemption error', {
        error: err.message,
        bookingId,
      });
    });

    throw error;
  }
}

module.exports = {
  redeemMiles,
  REMEDIATION_DIRECTIVE,
  CARD_PRODUCTS,
  REDEMPTION_PROGRAMS,
  BOOKING_TYPES,
};
