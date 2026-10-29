const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { scheduleSecuritySession } = require('../security-remediation-session');

// Learfield / Paciolan — Central Plains State University (fictional partner school)
// fan-facing ticketing + Thunderhawk Athletic Fund storefront.

const SERVICE = 'customer-learfield-paciolan';
const ROUTE = '/api/f2f40117/orders';
const CUSTOMER = 'f2f40117';
const SENTRY_ISSUE_QUERY = 'is:unresolved pointsFloor';
const LEARFIELD_SLACK_MEMBER_ID = process.env.LEARFIELD_SLACK_MEMBER_ID || '';

// The payments/PCI remediation session (COG-GTM/demo-vulns-swarm) starts this long
// after the game-day incident session so the two land as visibly separate sessions.
const SECURITY_SESSION_DELAY_MS = 60 * 1000;

const SCHOOL = {
  name: 'Central Plains State University',
  shortName: 'Central Plains State',
  mascot: 'Thunderhawks',
  annualFund: 'Thunderhawk Athletic Fund',
  annualFundAbbr: 'TAF',
  venue: 'Meridian Field at Thunderhawk Stadium',
  ticketOfficePhone: '(785) 555-0142',
};

const EVENTS = {
  'FB26-RIV': {
    eventId: 'FB26-RIV',
    sport: 'Football',
    season: '2026 Thunderhawk Football',
    title: 'Central Plains State vs. Western Ridge',
    subtitle: 'The Prairie Cup — Rivalry Game · Senior Day',
    opponent: 'Western Ridge Mountaineers',
    date: '2026-11-14',
    time: '2:30 PM CT',
    venue: SCHOOL.venue,
    status: 'sold_out_priority',
    statusLabel: 'Sold out — donor priority release',
    gates: 'Gates open 12:30 PM · Clear bag policy',
  },
  'FB26-HC': {
    eventId: 'FB26-HC',
    sport: 'Football',
    season: '2026 Thunderhawk Football',
    title: 'Central Plains State vs. Lakeshore Tech',
    subtitle: 'Homecoming',
    opponent: 'Lakeshore Tech Lakers',
    date: '2026-11-07',
    time: '6:00 PM CT',
    venue: SCHOOL.venue,
    status: 'on_sale',
    statusLabel: 'On sale',
    gates: 'Gates open 4:00 PM · Clear bag policy',
  },
  'MBB26-OPEN': {
    eventId: 'MBB26-OPEN',
    sport: "Men's Basketball",
    season: "2026-27 Thunderhawk Men's Basketball",
    title: 'Central Plains State vs. Red River State',
    subtitle: 'Season Opener',
    opponent: 'Red River State',
    date: '2026-11-10',
    time: '7:00 PM CT',
    venue: 'Harlan Fieldhouse',
    status: 'on_sale',
    statusLabel: 'On sale',
    gates: 'Doors open 5:30 PM',
  },
};

// Seat-map sections / price levels for Thunderhawk Stadium. `priorityHold` names
// the Priority Points release window that governs who may buy into the section
// while the game is sold out to the general public.
const SECTIONS = {
  '108': {
    sectionId: '108',
    label: 'Section 108 — Champions Club Sideline',
    priceLevel: 'Champions Club Sideline',
    level: 'lower',
    priorityHold: 'taf_champions_2026',
    prices: { adult: 185, youth: 185 },
    facilityFee: 6,
    rows: ['K', 'L', 'M'],
    seatsPerRow: 24,
    available: 14,
  },
  '101': {
    sectionId: '101',
    label: "Section 101 — Director's Circle (50-yard line)",
    priceLevel: "Director's Circle Sideline",
    level: 'lower',
    priorityHold: 'taf_directors_2026',
    prices: { adult: 265, youth: 265 },
    facilityFee: 6,
    rows: ['F', 'G', 'H'],
    seatsPerRow: 22,
    available: 6,
  },
  '215': {
    sectionId: '215',
    label: 'Section 215 — Varsity Reserved (Upper Sideline)',
    priceLevel: 'Varsity Reserved',
    level: 'upper',
    priorityHold: 'taf_varsity_2026',
    prices: { adult: 95, youth: 60 },
    facilityFee: 4,
    rows: ['C', 'D', 'E', 'F'],
    seatsPerRow: 28,
    available: 41,
  },
  '320': {
    sectionId: '320',
    label: 'Section 320 — North End Zone Reserved',
    priceLevel: 'End Zone Reserved',
    level: 'upper',
    priorityHold: 'general_public',
    prices: { adult: 55, youth: 30 },
    facilityFee: 4,
    rows: ['N', 'P', 'R', 'S', 'T'],
    seatsPerRow: 30,
    available: 112,
  },
};

// Priority Points release windows published by the Thunderhawk Athletic Fund for the
// 2026 season. The Champions Circle window moved to the restructured 2026 giving-level
// schedule in PAC Fund and still has to be registered here.
const PRIORITY_HOLDS = {
  taf_directors_2026: {
    label: "Director's Circle release",
    pointsFloor: 2500,
    minimumTier: 'directors_circle',
    maxPerOrder: 8,
    releaseOrder: 1,
  },
  taf_varsity_2026: {
    label: 'Varsity Club release',
    pointsFloor: 400,
    minimumTier: 'varsity_club',
    maxPerOrder: 6,
    releaseOrder: 3,
  },
  general_public: {
    label: 'General public',
    pointsFloor: 0,
    minimumTier: 'fan',
    maxPerOrder: 8,
    releaseOrder: 4,
  },
};

const DONOR_TIERS = {
  directors_circle: { label: "Director's Circle", rank: 1, annualGiving: 10000 },
  champions_circle: { label: 'Champions Circle', rank: 2, annualGiving: 2500 },
  varsity_club: { label: 'Varsity Club', rank: 3, annualGiving: 500 },
  fan: { label: 'Thunderhawk Fan', rank: 4, annualGiving: 0 },
};

const ACCOUNTS = {
  'CPS-4471028': {
    accountId: 'CPS-4471028',
    name: 'Jordan Whitfield',
    email: 'jordan.whitfield@example.com',
    donorTier: 'champions_circle',
    priorityPoints: 2860,
    priorityRank: 412,
    memberSince: 2014,
    seasonTicketHolder: true,
    paymentMethods: {
      'pm_visa_4421': { paymentMethodId: 'pm_visa_4421', brand: 'Visa', last4: '4421', expires: '09/28' },
      'pm_amex_1007': { paymentMethodId: 'pm_amex_1007', brand: 'American Express', last4: '1007', expires: '03/27' },
    },
  },
};

const PRICE_TYPES = ['adult', 'youth'];
const DELIVERY_METHODS = {
  mobile: { deliveryMethodId: 'mobile', label: 'Mobile Delivery', detail: 'Tickets delivered to the Thunderhawks Tickets app and by text message', fee: 0 },
  will_call: { deliveryMethodId: 'will_call', label: 'Will Call', detail: 'Pick up at the Thunderhawk Stadium ticket office — photo ID required', fee: 0 },
};
const ORDER_FEE = 7.5;
const MIN_QUANTITY = 1;
const MAX_QUANTITY = 8;
const PRIORITY_POINTS_PER_DOLLAR = 0.01; // 1 point per $100 given
const SEAT_PRIORITY_POINTS = 2; // per ticket purchased

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the Learfield / Paciolan game-day ticketing checkout failure below. This repository hosts many independent customer demos, each with its own intentional defect and its own Sentry issues. Investigate only POST /api/f2f40117/orders and do not modify any other vertical. Explicitly exclude RatingsDirect, Westpac, NRMA, CFS, QBE, HCF, Suncorp, Insignia, HUB24, Morgan Stanley, Entertainment Partners (02a5e918) and every unrelated vertical. The failing surface is app/public/verticals/f2f40117.html at GET /learfield (alias of GET /f2f40117), the Central Plains State University fan ticketing storefront powered by Paciolan; its "Complete Purchase" action posts to POST /api/f2f40117/orders in app/routes/verticals/f2f40117.js. The checkout pipeline is placeOrder -> allocatePrioritySeats -> resolvePriorityHold in app/services/verticals/f2f40117.js. Start at resolvePriorityHold: it looks up PRIORITY_HOLDS by the section's priorityHold key, and taf_champions_2026 (Section 108, Champions Club Sideline) is intentionally absent because the Champions Circle window moved to the restructured 2026 giving-level schedule, so the lookup returns undefined and allocatePrioritySeats dereferences hold.pointsFloor, throwing TypeError: Cannot read properties of undefined (reading 'pointsFloor'). Sections 101, 215 and 320 resolve correctly and succeed. Fix the root cause by registering the Champions Circle release window in PRIORITY_HOLDS (pointsFloor 1200, minimumTier champions_circle, maxPerOrder 6, releaseOrder 2) so Section 108 orders for Champions Circle donors complete, keep the existing successful sections unchanged, and add a regression test under tests/ (npm test only scans tests/) that places the default order (event FB26-RIV, section 108, 2 adult, mobile delivery, $100 TAF gift) and asserts success. Do not weaken validation and do not change the alert wiring (createSessionAndAlert / scheduleSecuritySession). Open a pull request against COG-GTM/event-driven-devin and do not merge it.`;

function resolvePriorityHold(section) {
  return PRIORITY_HOLDS[section.priorityHold];
}

function validationError(message, code = 'INVALID_ORDER') {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function makeOrderNumber() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 9).padEnd(9, '0');
  return `CPS-${digits}`;
}

function makeReceiptNumber() {
  const digits = uuidv4().replace(/\D/g, '').slice(0, 7).padEnd(7, '0');
  return `TAF-${digits}`;
}

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function assignSeats(section, quantity) {
  const row = section.rows[0];
  const start = Math.max(1, Math.floor(section.seatsPerRow / 2) - Math.floor(quantity / 2));
  const seats = [];
  for (let i = 0; i < quantity; i += 1) {
    seats.push({ section: section.sectionId, row, seat: start + i });
  }
  return seats;
}

function allocatePrioritySeats(account, section, quantity) {
  const hold = resolvePriorityHold(section);
  const pointsFloor = hold.pointsFloor;
  const tier = DONOR_TIERS[account.donorTier];
  const minimumTier = DONOR_TIERS[hold.minimumTier];

  if (quantity > hold.maxPerOrder) {
    throw validationError(`${hold.label} allows up to ${hold.maxPerOrder} tickets per order`, 'PRIORITY_LIMIT_EXCEEDED');
  }
  if (account.priorityPoints < pointsFloor || tier.rank > minimumTier.rank) {
    throw validationError(
      `${section.label} is held for ${minimumTier.label} members with ${pointsFloor.toLocaleString('en-US')}+ Priority Points`,
      'PRIORITY_HOLD_NOT_MET',
    );
  }
  if (quantity > section.available) {
    throw validationError(`Only ${section.available} seats remain in ${section.label}`, 'SECTION_SOLD_OUT');
  }

  return {
    seats: assignSeats(section, quantity),
    holdLabel: hold.label,
    pointsFloor,
    releaseOrder: hold.releaseOrder,
  };
}

async function placeOrder(data) {
  const startTime = Date.now();
  const orderNumber = makeOrderNumber();
  const eventId = data.eventId;
  const sectionId = String(data.sectionId == null ? '' : data.sectionId);
  const priceType = data.priceType;
  const quantity = data.quantity;
  const deliveryMethodId = data.deliveryMethod;
  const donationAmount = data.donationAmount;
  const accountId = data.accountId;
  const paymentMethodId = data.paymentMethodId;

  const event = EVENTS[eventId];
  const section = SECTIONS[sectionId];
  const account = ACCOUNTS[accountId];
  const deliveryMethod = DELIVERY_METHODS[deliveryMethodId];

  if (!event) throw validationError(`Unknown event: ${eventId || '(none)'}`, 'UNKNOWN_EVENT');
  if (!section) throw validationError(`Unknown section: ${sectionId || '(none)'}`, 'UNKNOWN_SECTION');
  if (!account) throw validationError('Please sign in to your ticket account to complete this purchase', 'ACCOUNT_REQUIRED');
  if (!PRICE_TYPES.includes(priceType)) throw validationError('Price type is invalid', 'INVALID_PRICE_TYPE');
  if (!Number.isInteger(quantity) || quantity < MIN_QUANTITY || quantity > MAX_QUANTITY) {
    throw validationError(`Quantity must be between ${MIN_QUANTITY} and ${MAX_QUANTITY}`, 'INVALID_QUANTITY');
  }
  if (!deliveryMethod) throw validationError('Delivery method is invalid', 'INVALID_DELIVERY_METHOD');
  if (!Number.isFinite(donationAmount) || donationAmount < 0) {
    throw validationError('Gift amount must be zero or greater', 'INVALID_DONATION');
  }
  const paymentMethod = account.paymentMethods[paymentMethodId];
  if (!paymentMethod) throw validationError('Select a payment method', 'INVALID_PAYMENT_METHOD');

  const unitPrice = section.prices[priceType];
  const ticketSubtotal = roundMoney(unitPrice * quantity);
  const facilityFees = roundMoney(section.facilityFee * quantity);
  const orderTotal = roundMoney(ticketSubtotal + facilityFees + ORDER_FEE + deliveryMethod.fee + donationAmount);

  logger.info('Placing Paciolan ticket order', {
    orderNumber,
    eventId,
    eventTitle: event.title,
    sectionId,
    priceLevel: section.priceLevel,
    priorityHold: section.priorityHold,
    priceType,
    quantity,
    deliveryMethod: deliveryMethodId,
    donationAmount,
    orderTotal,
    accountId,
    donorTier: account.donorTier,
    priorityPoints: account.priorityPoints,
    channel: data.channel,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const allocation = allocatePrioritySeats(account, section, quantity);
    const duration = Date.now() - startTime;
    const placedAt = new Date().toISOString();
    const pointsEarned = Math.round(donationAmount * PRIORITY_POINTS_PER_DOLLAR) + SEAT_PRIORITY_POINTS * quantity;

    incrementMetric('f2f40117_order.success', { route: ROUTE, sectionId, priorityHold: section.priorityHold });
    recordTiming('f2f40117_order.latency', duration, { route: ROUTE });

    return {
      success: true,
      status: 'confirmed',
      orderNumber,
      placedAt,
      event: { ...event },
      section: {
        sectionId: section.sectionId,
        label: section.label,
        priceLevel: section.priceLevel,
        level: section.level,
      },
      priceType,
      quantity,
      unitPrice,
      seats: allocation.seats,
      priorityRelease: {
        label: allocation.holdLabel,
        pointsFloor: allocation.pointsFloor,
        releaseOrder: allocation.releaseOrder,
      },
      delivery: { ...deliveryMethod },
      donation: donationAmount > 0
        ? { amount: donationAmount, fund: SCHOOL.annualFund, receiptNumber: makeReceiptNumber(), taxDeductible: true }
        : null,
      payment: { brand: paymentMethod.brand, last4: paymentMethod.last4 },
      totals: {
        ticketSubtotal,
        facilityFees,
        orderFee: ORDER_FEE,
        deliveryFee: deliveryMethod.fee,
        donation: donationAmount,
        orderTotal,
      },
      account: {
        accountId: account.accountId,
        name: account.name,
        donorTier: account.donorTier,
        donorTierLabel: DONOR_TIERS[account.donorTier].label,
        priorityPointsBefore: account.priorityPoints,
        priorityPointsEarned: pointsEarned,
        priorityPointsAfter: account.priorityPoints + pointsEarned,
      },
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const metricTags = { route: ROUTE, errorClass: error.name, sectionId, priorityHold: section.priorityHold };

    incrementMetric('f2f40117_order.failure', metricTags);
    recordTiming('f2f40117_order.latency', duration, { route: ROUTE, error: 'true' });

    if (error.name === 'ValidationError') {
      throw error;
    }

    logger.error('Paciolan ticket order failed', {
      orderNumber,
      eventId,
      eventTitle: event.title,
      sectionId,
      priceLevel: section.priceLevel,
      priorityHold: section.priorityHold,
      priceType,
      quantity,
      deliveryMethod: deliveryMethodId,
      donationAmount,
      orderTotal,
      accountId,
      donorTier: account.donorTier,
      priorityPoints: account.priorityPoints,
      channel: data.channel,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
      route: ROUTE,
    });

    Sentry.captureException(error, {
      tags: {
        alert_path: 'instant',
        route: ROUTE,
        service: SERVICE,
        eventId,
        sectionId,
        priorityHold: section.priorityHold,
        donorTier: account.donorTier,
      },
      extra: {
        orderNumber,
        eventTitle: event.title,
        priceLevel: section.priceLevel,
        priceType,
        quantity,
        deliveryMethod: deliveryMethodId,
        donationAmount,
        orderTotal,
        accountId,
        priorityPoints: account.priorityPoints,
        channel: data.channel,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      culprit: 'app/services/verticals/f2f40117.js — allocatePrioritySeats',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: SERVICE,
      verticalLabel: 'Learfield / Paciolan — Central Plains State Game-Day Ticketing',
      customer: CUSTOMER,
      slackMemberId: data.devinEmail ? '' : LEARFIELD_SLACK_MEMBER_ID,
      slackMemberIdFallback: LEARFIELD_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      skipVulnerablePr: true,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'eventId', value: eventId },
        { key: 'sectionId', value: sectionId },
        { key: 'priorityHold', value: section.priorityHold },
        { key: 'donorTier', value: account.donorTier },
      ],
      extra: {
        orderNumber,
        eventTitle: event.title,
        priceLevel: section.priceLevel,
        priceType,
        quantity,
        deliveryMethod: deliveryMethodId,
        donationAmount,
        orderTotal,
        accountId,
        priorityPoints: account.priorityPoints,
        channel: data.channel,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: 'customer-learfield-paciolan@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Paciolan ticket order error', {
        orderNumber,
        error: alertError.message,
      });
    });
    scheduleSecuritySession({
      customer: CUSTOMER,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      delayMs: SECURITY_SESSION_DELAY_MS,
    });

    throw error;
  }
}

function publicAccount(account) {
  return {
    accountId: account.accountId,
    name: account.name,
    email: account.email,
    donorTier: account.donorTier,
    donorTierLabel: DONOR_TIERS[account.donorTier].label,
    priorityPoints: account.priorityPoints,
    priorityRank: account.priorityRank,
    memberSince: account.memberSince,
    seasonTicketHolder: account.seasonTicketHolder,
    paymentMethods: Object.values(account.paymentMethods),
  };
}

function getStorefront() {
  return {
    school: SCHOOL,
    events: Object.values(EVENTS),
    sections: Object.values(SECTIONS).map((section) => ({
      sectionId: section.sectionId,
      label: section.label,
      priceLevel: section.priceLevel,
      level: section.level,
      priorityHold: section.priorityHold,
      prices: section.prices,
      facilityFee: section.facilityFee,
      available: section.available,
    })),
    deliveryMethods: Object.values(DELIVERY_METHODS),
    orderFee: ORDER_FEE,
    account: publicAccount(ACCOUNTS['CPS-4471028']),
  };
}

module.exports = {
  placeOrder,
  allocatePrioritySeats,
  resolvePriorityHold,
  getStorefront,
  SCHOOL,
  EVENTS,
  SECTIONS,
  PRIORITY_HOLDS,
  DONOR_TIERS,
  ACCOUNTS,
  DELIVERY_METHODS,
  ORDER_FEE,
  SECURITY_SESSION_DELAY_MS,
  REMEDIATION_DIRECTIVE,
};
