const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { runWithAlertDestination } = require('../alert-destination');

const SERVICE = 'ual-ticketing-fulfillment';
const ROUTE = '/api/3503d9e5/bookings';
const PAGE = '/3503d9e5';

/**
 * Scenario directive appended to the Devin investigation prompt.
 *
 * The alert pipeline passes only a prompt to the Devin API, so the repository
 * to remediate has to be named explicitly here.
 */
const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the united.com flight booking (purchase) flow:',
  '- Service: `app/services/verticals/3503d9e5.js`',
  '- Route: `app/routes/verticals/3503d9e5.js`',
  '- Page: `app/public/verticals/3503d9e5.html` (served at `/3503d9e5`)',
  '',
  'Start from the fare brand the customer selected on the flight search results',
  'and work back through how ticketing resolves that brand before issuing the ticket.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

class ValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValidationError';
    this.statusCode = 400;
  }
}

/** 7.5% federal excise tax plus per-segment fixed charges on a nonstop roundtrip. */
const US_EXCISE_RATE = 0.075;
const FIXED_TAXES = [
  { code: 'ZP', label: 'U.S. flight segment tax', amount: 10.6 },
  { code: 'AY', label: 'September 11th Security Fee', amount: 11.2 },
  { code: 'XF', label: 'Passenger Facility Charge', amount: 9.0 },
];

const AIRPORTS = {
  EWR: { code: 'EWR', city: 'Newark, NJ/New York, NY, US' },
  SFO: { code: 'SFO', city: 'San Francisco, CA, US' },
};

const SEARCH = {
  origin: 'EWR',
  destination: 'SFO',
  departDate: '2026-11-12',
  returnDate: '2026-11-16',
};

/**
 * FSR inventory for the demo market. `economyFrom` is the roundtrip Basic
 * Economy price; premium cabins are roundtrip totals or null when sold out.
 */
const FLIGHTS = {
  outbound: [
    { flightNumber: 'UA 648', depart: '6:00 AM', arrive: '9:30 AM', duration: '6H, 30M', aircraft: 'Boeing 757-200', co2Kg: 351, economyFrom: 437, economyPlus: 959, premiumPlus: null, polaris: 5296 },
    { flightNumber: 'UA 1180', depart: '7:00 AM', arrive: '10:27 AM', duration: '6H, 27M', aircraft: 'Boeing 777-300ER', co2Kg: 365, economyFrom: 437, economyPlus: 959, premiumPlus: 1779, polaris: 3888 },
    { flightNumber: 'UA 1593', depart: '8:00 AM', arrive: '11:41 AM', duration: '6H, 41M', aircraft: 'Boeing 757-200', co2Kg: 361, economyFrom: 437, economyPlus: 959, premiumPlus: null, polaris: 5296 },
    { flightNumber: 'UA 1777', depart: '9:00 AM', arrive: '12:27 PM', duration: '6H, 27M', aircraft: 'Boeing 787-10 Dreamliner', co2Kg: 372, economyFrom: 467, economyPlus: 989, premiumPlus: 1809, polaris: 3918 },
    { flightNumber: 'UA 2416', depart: '12:00 PM', arrive: '3:24 PM', duration: '6H, 24M', aircraft: 'Boeing 777-200', co2Kg: 358, economyFrom: 497, economyPlus: 1019, premiumPlus: null, polaris: 4106 },
  ],
  inbound: [
    { flightNumber: 'UA 2207', depart: '7:00 AM', arrive: '3:36 PM', duration: '5H, 36M', aircraft: 'Boeing 777-200', co2Kg: 322, economyFrom: 437, economyPlus: 959, premiumPlus: null, polaris: 3888 },
    { flightNumber: 'UA 1296', depart: '8:40 AM', arrive: '5:12 PM', duration: '5H, 32M', aircraft: 'Boeing 757-300', co2Kg: 318, economyFrom: 437, economyPlus: 959, premiumPlus: null, polaris: 3888 },
    { flightNumber: 'UA 535', depart: '1:05 PM', arrive: '9:39 PM', duration: '5H, 34M', aircraft: 'Boeing 787-9 Dreamliner', co2Kg: 327, economyFrom: 437, economyPlus: 959, premiumPlus: 1779, polaris: 3888 },
    { flightNumber: 'UA 1730', depart: '10:30 PM', arrive: '6:59 AM', arriveNextDay: true, duration: '5H, 29M', aircraft: 'Boeing 777-300ER', co2Kg: 330, economyFrom: 437, economyPlus: 959, premiumPlus: 1779, polaris: 3888 },
  ],
};

/**
 * Shopping (FSR) fare-family catalog: what the results grid and the
 * "Select a fare to continue" cards render. Owned by Shopping.
 */
const FARE_FAMILIES = {
  economy: {
    column: 'United Economy®',
    options: [
      { code: 'ECO-BASIC', family: 'United Economy®', name: 'Basic (Most restrictive)', delta: 0, milesPerPqp: 0, pqf: 0, requiresAck: true },
      { code: 'ECO-STANDARD', family: 'United Economy®', name: 'Standard', delta: 130, milesPerPqp: 3, pqf: 1 },
      { code: 'ECO-FLEXIBLE', family: 'United Economy®', name: 'Flexible', delta: 230, milesPerPqp: 3, pqf: 1, badge: 'Fully refundable' },
    ],
  },
  economyPlus: {
    column: 'Economy Plus®',
    options: [{ code: 'ECO-PLUS', family: 'Economy Plus®', name: 'Extra legroom', delta: 0, milesPerPqp: 3, pqf: 1 }],
  },
  premiumPlus: {
    column: 'United Premium Plus®',
    options: [{ code: 'PREMIUM-PLUS', family: 'United Premium Plus®', name: 'Roomier seat', delta: 0, milesPerPqp: 3, pqf: 1 }],
  },
  polaris: {
    column: 'United Polaris®/United First®',
    options: [{ code: 'MIN-BUSINESS-OR-FIRST', family: 'United Polaris® business', name: 'Enhanced onboard experience', delta: 0, milesPerPqp: 3, pqf: 1 }],
  },
};

/**
 * Ticketing & Fulfillment fare-brand rules: the conditions written onto the
 * electronic ticket (bag allowance, change/refund, seat, accrual). Owned by
 * Ticketing, keyed by the fare brand code Shopping sends on the order.
 *
 * Fall '26 Economy refresh: Shopping renamed the Standard Economy brand from
 * `ECONOMY` to `ECO-STANDARD` so it pairs with `ECO-BASIC` / `ECO-FLEXIBLE`
 * in the fare-compare grid. The matching Ticketing entry was cut from the
 * release train (TKT-4471, "alias ECONOMY → ECO-STANDARD") pending revenue
 * accounting sign-off on the fare basis suffix, so the registry still only
 * knows the legacy code. Unknown brands used to be priced off the ATPCO filing
 * at the GDS, which is why the lookup below has no default.
 */
const FARE_BRAND_RULES = {
  'ECO-BASIC': {
    cabin: 'Economy', bookingClass: 'N', fareBasisSuffix: 'NN',
    carryOn: { allowance: 0, personalItem: 1 },
    checkedBags: { first: 40, second: 50 },
    changes: { allowed: false, fee: null },
    refundable: false, seatSelection: 'fee', upgrades: false,
  },
  ECONOMY: {
    cabin: 'Economy', bookingClass: 'L', fareBasisSuffix: 'AA',
    carryOn: { allowance: 1, personalItem: 1 },
    checkedBags: { first: 40, second: 50 },
    changes: { allowed: true, fee: 0 },
    refundable: false, seatSelection: 'included', upgrades: true,
  },
  'ECO-FLEXIBLE': {
    cabin: 'Economy', bookingClass: 'Y', fareBasisSuffix: 'UF',
    carryOn: { allowance: 1, personalItem: 1 },
    checkedBags: { first: 40, second: 50 },
    changes: { allowed: true, fee: 0 },
    refundable: true, seatSelection: 'included', upgrades: true,
  },
  'ECO-PLUS': {
    cabin: 'Economy Plus', bookingClass: 'M', fareBasisSuffix: 'AA',
    carryOn: { allowance: 1, personalItem: 1 },
    checkedBags: { first: 40, second: 50 },
    changes: { allowed: true, fee: 0 },
    refundable: false, seatSelection: 'included', upgrades: true,
  },
  'PREMIUM-PLUS': {
    cabin: 'Premium Plus', bookingClass: 'O', fareBasisSuffix: 'PP',
    carryOn: { allowance: 1, personalItem: 1 },
    checkedBags: { first: 0, second: 0 },
    changes: { allowed: true, fee: 0 },
    refundable: false, seatSelection: 'included', upgrades: true,
  },
  'MIN-BUSINESS-OR-FIRST': {
    cabin: 'Polaris business', bookingClass: 'P', fareBasisSuffix: 'IN',
    carryOn: { allowance: 1, personalItem: 1 },
    checkedBags: { first: 0, second: 0 },
    changes: { allowed: true, fee: 0 },
    refundable: false, seatSelection: 'included', upgrades: false,
  },
};

const CABIN_PRICE_FIELD = {
  economy: 'economyFrom', economyPlus: 'economyPlus', premiumPlus: 'premiumPlus', polaris: 'polaris',
};

const DEFAULT_BOOKING = {
  outbound: 'UA 1180',
  inbound: 'UA 535',
  cabin: 'economy',
  fareBrand: 'ECO-STANDARD',
};

function round2(n) {
  return Math.round(n * 100) / 100;
}

/** Splits a roundtrip total into base fare and U.S. taxes and fees. */
function computeFareBreakdown(total) {
  const fixed = FIXED_TAXES.reduce((sum, t) => sum + t.amount, 0);
  const baseFare = round2((total - fixed) / (1 + US_EXCISE_RATE));
  const excise = round2(total - fixed - baseFare);
  const taxes = [{ code: 'US', label: 'U.S. Transportation Tax', amount: excise }, ...FIXED_TAXES];
  return {
    baseFare,
    taxes,
    taxesTotal: round2(taxes.reduce((sum, t) => sum + t.amount, 0)),
    total: round2(total),
  };
}

function findFlight(direction, flightNumber) {
  return FLIGHTS[direction].find((f) => f.flightNumber === flightNumber);
}

function findFareOption(cabin, code) {
  const family = FARE_FAMILIES[cabin];
  return family && family.options.find((o) => o.code === code);
}

/** Roundtrip price for a fare option on an outbound flight, or null if sold out. */
function priceFor(flight, cabin, option) {
  const from = flight[CABIN_PRICE_FIELD[cabin]];
  if (from == null) return null;
  return from + option.delta;
}

function describeOption(flight, cabin, option) {
  const price = priceFor(flight, cabin, option);
  if (price == null) return null;
  const { baseFare } = computeFareBreakdown(price);
  const pqp = Math.round(baseFare / 2);
  return {
    ...option,
    price,
    pqp,
    miles: pqp * option.milesPerPqp,
  };
}

/** Search results payload for the FSR page. */
function getFlightSearch() {
  const withFares = (flight) => ({
    ...flight,
    fares: Object.fromEntries(Object.keys(FARE_FAMILIES).map((cabin) => [
      cabin,
      FARE_FAMILIES[cabin].options.map((o) => describeOption(flight, cabin, o)).filter(Boolean),
    ])),
  });
  return {
    search: { ...SEARCH, originCity: AIRPORTS[SEARCH.origin].city, destinationCity: AIRPORTS[SEARCH.destination].city },
    columns: Object.fromEntries(Object.entries(FARE_FAMILIES).map(([k, v]) => [k, v.column])),
    outbound: FLIGHTS.outbound.map(withFares),
    inbound: FLIGHTS.inbound.map(withFares),
    defaultBooking: DEFAULT_BOOKING,
  };
}

/** Ticketing lookup for the brand Shopping sent on the order. */
function resolveFareBrandRules(fareBrand) {
  return FARE_BRAND_RULES[fareBrand];
}

/** Conditions written onto the eTicket coupon for the selected fare brand. */
function buildTicketingConditions(fareBrand, rules) {
  return {
    fareBrand,
    carryOnBags: rules.carryOn.allowance,
    personalItems: rules.carryOn.personalItem,
    cabin: rules.cabin,
    fareBasis: `${rules.bookingClass}${rules.fareBasisSuffix}A7AUP`,
    firstCheckedBagFee: rules.checkedBags.first,
    changeable: rules.changes.allowed,
    changeFee: rules.changes.fee,
    refundable: rules.refundable,
    seatSelection: rules.seatSelection,
    upgradeEligible: rules.upgrades,
  };
}

const PNR_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateConfirmationNumber() {
  let out = '';
  for (let i = 0; i < 6; i++) out += PNR_ALPHABET[Math.floor(Math.random() * PNR_ALPHABET.length)];
  return out;
}

function generateTicketNumber() {
  let digits = '';
  for (let i = 0; i < 10; i++) digits += Math.floor(Math.random() * 10);
  return `016${digits}`;
}

function validate(data) {
  const outbound = findFlight('outbound', data.outbound);
  if (!outbound) throw new ValidationError(`Unknown departing flight: ${data.outbound}`);
  const inbound = findFlight('inbound', data.inbound);
  if (!inbound) throw new ValidationError(`Unknown return flight: ${data.inbound}`);
  const option = findFareOption(data.cabin, data.fareBrand);
  if (!option) throw new ValidationError(`Fare ${data.fareBrand} is not offered in ${data.cabin}`);
  const price = priceFor(outbound, data.cabin, option);
  if (price == null) throw new ValidationError(`${FARE_FAMILIES[data.cabin].column} is not available on ${outbound.flightNumber}`);
  if (option.requiresAck && !data.basicEconomyAck) {
    throw new ValidationError('Please confirm that Basic Economy works for you.');
  }
  const traveler = data.traveler || {};
  if (!traveler.firstName || !traveler.lastName) throw new ValidationError('Traveler first and last name are required.');
  const payment = data.payment || {};
  if (!/^\d{4}$/.test(String(payment.cardLast4 || ''))) throw new ValidationError('A valid card is required.');
  return { outbound, inbound, option, price };
}

/**
 * Purchase: price the itinerary, resolve the ticketing rules for the fare
 * brand, and issue the eTicket.
 */
async function processBooking(data) {
  const bookingId = uuidv4();
  const startTime = Date.now();
  const { outbound, inbound, option, price } = validate(data);
  const market = `${SEARCH.origin}-${SEARCH.destination}`;

  logger.info('United booking purchase started', {
    bookingId, market, outbound: outbound.flightNumber, inbound: inbound.flightNumber, fareBrand: option.code,
  });

  try {
    const pricing = computeFareBreakdown(price);
    const rules = resolveFareBrandRules(option.code);
    const conditions = buildTicketingConditions(option.code, rules);
    const pqp = Math.round(pricing.baseFare);

    const booking = {
      bookingId,
      confirmationNumber: generateConfirmationNumber(),
      ticketNumber: generateTicketNumber(),
      status: 'TICKETED',
      market,
      segments: [
        { direction: 'Depart', date: SEARCH.departDate, from: SEARCH.origin, to: SEARCH.destination, ...outbound },
        { direction: 'Return', date: SEARCH.returnDate, from: SEARCH.destination, to: SEARCH.origin, ...inbound },
      ],
      fare: { code: option.code, family: option.family, name: option.name },
      conditions,
      pricing,
      accrual: { pqp, pqf: option.pqf * 2, miles: pqp * option.milesPerPqp },
      traveler: { firstName: data.traveler.firstName, lastName: data.traveler.lastName },
      payment: { brand: data.payment.brand || 'Visa', cardLast4: data.payment.cardLast4 },
    };

    incrementMetric('ual_booking.success', { route: ROUTE, fareBrand: option.code });
    recordTiming('ual_booking.latency', Date.now() - startTime, { route: ROUTE });
    logger.info('United booking ticketed', { bookingId, confirmationNumber: booking.confirmationNumber, fareBrand: option.code });

    return { success: true, booking };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('ual_booking.failure', { route: ROUTE, errorClass: error.name, fareBrand: option.code });
    recordTiming('ual_booking.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('United booking purchase failed', {
      bookingId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      market,
      outbound: outbound.flightNumber,
      inbound: inbound.flightNumber,
      fareBrand: option.code,
    });

    const extra = {
      bookingId, market, outbound: outbound.flightNumber, inbound: inbound.flightNumber, fareBrand: option.code, cabin: data.cabin, total: price,
    };

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, fareBrand: option.code, market, page: PAGE,
      },
      extra,
    });

    // United runs its incident bridge in Microsoft Teams: always alert there, never Slack,
    // whatever the presenter's hub picker says.
    runWithAlertDestination('teams', () => createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/3503d9e5.js — buildTicketingConditions',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'united.com Booking — Purchase & Ticketing',
      customer: '3503d9e5',
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'fareBrand', value: option.code },
        { key: 'market', value: market },
        { key: 'page', value: PAGE },
      ],
      extra,
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'ual-booking-web@26.10.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    })).catch((err) => {
      logger.error('Failed to trigger Devin session from United booking error', { error: err.message });
    });

    error.bookingId = bookingId;
    throw error;
  }
}

module.exports = {
  processBooking,
  getFlightSearch,
  computeFareBreakdown,
  resolveFareBrandRules,
  buildTicketingConditions,
  ValidationError,
  FLIGHTS,
  FARE_FAMILIES,
  FARE_BRAND_RULES,
  DEFAULT_BOOKING,
  REMEDIATION_DIRECTIVE,
  SERVICE,
  ROUTE,
};
