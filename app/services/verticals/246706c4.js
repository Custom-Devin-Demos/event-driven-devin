const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = '246706c4-api';
const ROUTE = '/api/246706c4/payment';
const SLACK_MEMBER_ID = process.env.C246706C4_SLACK_MEMBER_ID || 'U08S7AVJ478';

const BOOKINGS = [
  {
    bookingId: 'AGB-7H3K2Q',
    vehicle: { vrm: 'AG24 APP', make: 'Volkswagen', model: 'Golf', year: 2022, adas: true },
    job: { code: 'CHIP_REPAIR', label: 'Chip repair', glass: 'Windscreen' },
    addOns: [{ sku: 'WIPER-BOSCH-AEROTWIN', label: 'Bosch wiper blades', pence: 2999 }],
    appointment: { type: 'mobile', address: 'Wellington Place, Leeds', postcode: 'LS1 4AP', slot: 'Today, 12:00–13:00', technician: 'Leeds Mobile Unit 4' },
    cover: { route: 'insurance', insurer: 'Admiral', policyRef: 'ADM-55210983', excessPence: 0 },
  },
  {
    bookingId: 'AGB-9M4T7X',
    vehicle: { vrm: 'OY71 KXN', make: 'Ford', model: 'Transit Custom', year: 2021, adas: false },
    job: { code: 'WINDSCREEN_REPLACE', label: 'Windscreen replacement', glass: 'Windscreen' },
    addOns: [{ sku: 'RAIN-REPEL', label: 'Rain Repel treatment', pence: 1499 }],
    appointment: { type: 'branch', address: 'Branch 214, Birstall', postcode: 'WF17 9AE', slot: 'Tomorrow, 09:00–11:00', technician: 'Birstall Fitting Bay 2' },
    cover: { route: 'self_pay', insurer: null, policyRef: null, excessPence: 0 },
  },
  {
    bookingId: 'AGB-2C8P5N',
    vehicle: { vrm: 'LV69 BZR', make: 'BMW', model: '3 Series', year: 2019, adas: true },
    job: { code: 'SIDE_GLASS', label: 'Side window replacement', glass: 'Driver front door glass' },
    addOns: [],
    appointment: { type: 'mobile', address: 'Clarence Dock, Leeds', postcode: 'LS10 1PZ', slot: 'Today, 15:00–16:00', technician: 'Leeds Mobile Unit 7' },
    cover: { route: 'insurance', insurer: 'Aviva', policyRef: 'AVI-88410276', excessPence: 7500 },
  },
];

const PRICE_BOOK = {
  CHIP_REPAIR: { retailPence: 9999, insurerPence: 8500 },
  WINDSCREEN_REPLACE: { retailPence: 38900, insurerPence: 31000 },
  SIDE_GLASS: { retailPence: 21500, insurerPence: 17800 },
};

const GATEWAY = { name: 'Adyen', merchant: 'AGUK-ONLINE', currency: 'GBP' };

function findBooking(bookingId) {
  const booking = BOOKINGS.find((b) => b.bookingId === bookingId);
  if (!booking) throw new Error('Booking not found');
  return booking;
}

function quoteSettlement(booking) {
  const addOnPence = booking.addOns.reduce((sum, a) => sum + a.pence, 0);
  const insured = booking.cover.route === 'insurance';
  const insurerPence = insured ? PRICE_BOOK[booking.job.code].insurerPence : 0;
  const customerPence = booking.cover.excessPence + addOnPence + (insured ? 0 : PRICE_BOOK[booking.job.code].retailPence);
  return {
    insurerPence,
    customerPence,
    addOnPence,
    totalDuePence: customerPence,
  };
}

async function authorisePayment(card, amountPence) {
  await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 60));
  return {
    authCode: `A${uuidv4().replace(/-/g, '').slice(0, 7).toUpperCase()}`,
    scheme: card.scheme,
    last4: card.last4,
    amountPence,
    capturedAt: new Date().toISOString(),
  };
}

function settleBooking(booking, card, settlement) {
  const auth = authorisePayment(card, settlement.customerPence);
  return buildReceipt(booking, settlement, auth);
}

function buildReceipt(booking, settlement, auth) {
  const authCodeTail = auth.authCode.slice(-4);
  return {
    reference: `AG-${booking.bookingId.slice(4)}-${authCodeTail}`,
    authCodeTail,
    amountPence: auth.amountPence,
    scheme: auth.scheme,
    last4: auth.last4,
    capturedAt: auth.capturedAt,
  };
}

function formatConfirmation(booking, settlement, receipt) {
  return {
    bookingId: booking.bookingId,
    reference: receipt.reference,
    vehicle: booking.vehicle,
    appointment: booking.appointment,
    charged: {
      amountPence: receipt.amountPence,
      display: `£${(receipt.amountPence / 100).toFixed(2)}`,
      currency: GATEWAY.currency,
    },
    payment: { scheme: receipt.scheme, last4: receipt.last4, authCodeTail: receipt.authCodeTail },
    nextSteps: [
      'We confirm by email and in your account',
      'The day before, we confirm your technician',
      'On the day, track them live',
    ],
  };
}

async function confirmBooking(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Confirming booking and taking payment', {
    requestId,
    bookingId: data.bookingId,
    paymentMethod: data.paymentMethod,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const booking = findBooking(data.bookingId);
    const settlement = quoteSettlement(booking);
    const receipt = settleBooking(booking, data.card, settlement);
    const confirmation = formatConfirmation(booking, settlement, receipt);

    const duration = Date.now() - startTime;
    incrementMetric('246706c4.payment.success', {
      route: ROUTE,
      paymentMethod: data.paymentMethod,
      job: booking.job.code,
      coverRoute: booking.cover.route,
    });
    recordTiming('246706c4.payment.latency', duration, { route: ROUTE });

    return { success: true, requestId, ...confirmation };
  } catch (error) {
    const duration = Date.now() - startTime;
    const booking = BOOKINGS.find((b) => b.bookingId === data.bookingId);

    incrementMetric('246706c4.payment.failure', {
      route: ROUTE,
      errorClass: error.name,
      paymentMethod: data.paymentMethod,
    });
    recordTiming('246706c4.payment.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Booking confirmation payment failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      bookingId: data.bookingId,
      paymentMethod: data.paymentMethod,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, source: 'booking-confirm-pay', alert_path: 'instant' },
      extra: {
        requestId,
        bookingId: data.bookingId,
        vrm: booking ? booking.vehicle.vrm : undefined,
        amountPence: booking ? quoteSettlement(booking).customerPence : undefined,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/246706c4.js — buildReceipt',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: '246706c4',
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      service: SERVICE,
      verticalLabel: 'Glass Repair — Booking Confirm & Pay',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'payment_method', value: data.paymentMethod },
        { key: 'booking_id', value: data.bookingId },
      ],
      extra: {
        requestId,
        bookingId: data.bookingId,
        vrm: booking ? booking.vehicle.vrm : undefined,
        amountPence: booking ? quoteSettlement(booking).customerPence : undefined,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '246706c4@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message });
    });

    throw error;
  }
}

module.exports = { confirmBooking, BOOKINGS, PRICE_BOOK };
