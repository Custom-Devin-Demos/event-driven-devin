const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const PROPERTIES = {
  maui: { name: 'Maui Shores Resort', region: 'hawaii', seasonFactor: 1.35, taxRate: 0.0417 },
  kauai: { name: 'Kauai Garden Inn', region: 'hawaii', seasonFactor: 1.20, taxRate: 0.0417 },
  oahu: { name: 'Oahu Grand Hotel', region: 'hawaii', seasonFactor: 1.10, taxRate: 0.0417 },
  'big-island': { name: 'Big Island Lodge', region: 'hawaii', seasonFactor: 1.05, taxRate: 0.0417 },
  lanai: { name: 'Lanai Hideaway', region: 'hawaii', seasonFactor: 1.50, taxRate: 0.0417 },
};

const ROOM_CATALOG = {
  standard: { sku: 'STD-100', nightlyRate: 189, maxOccupancy: 2, sqft: 350 },
  deluxe:   { sku: 'DLX-200', nightlyRate: 289, maxOccupancy: 3, sqft: 500 },
  suite:    { sku: 'STE-300', nightlyRate: 449, maxOccupancy: 4, sqft: 750 },
  villa:    { sku: 'VLA-400', nightlyRate: 699, maxOccupancy: 6, sqft: 1200 },
  penthouse: { sku: 'PH-500', nightlyRate: 1299, maxOccupancy: 4, sqft: 1800 },
};

const INVENTORY = {
  maui:     { standard: 40, deluxe: 25, suite: 12, villa: 6, penthouse: 2 },
  kauai:    { standard: 30, deluxe: 18, suite: 8, villa: 4, penthouse: 1 },
  oahu:     { standard: 55, deluxe: 30, suite: 15, villa: 8, penthouse: 3 },
  'big-island': { standard: 35, deluxe: 20, suite: 10, villa: 5, penthouse: 2 },
  lanai:    { standard: 15, deluxe: 10, suite: 5, villa: 3, penthouse: 1 },
};

function getRoomAvailability(propertyCode) {
  const counts = INVENTORY[propertyCode];
  if (!counts) return null;
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  const available = Math.floor(total * (0.3 + Math.random() * 0.4));
  return {
    inventory: {
      available,
      total,
      occupancyRate: ((total - available) / total * 100).toFixed(1),
    },
    breakdown: counts,
  };
}

function computeBookingMetrics(rooms, propertyCode) {
  const availability = getRoomAvailability(propertyCode);
  return rooms.map((room) => {
    const adjustedRate = room.nightlyRate * (availability.inventory.available / availability.inventory.total);
    const belowThreshold = room.available < 5;
    return {
      sku: room.sku,
      adjustedRate: adjustedRate.toFixed(2),
      occupancyRate: availability.inventory.occupancyRate,
      lowAvailability: belowThreshold,
    };
  });
}

function calculateStayTotal(nightlyRate, nights, property) {
  const propConfig = PROPERTIES[property];
  if (!propConfig) return null;
  const subtotal = nightlyRate * nights * propConfig.seasonFactor;
  const tax = subtotal * propConfig.taxRate;
  const resortFee = nights * 35;
  return {
    subtotal: subtotal.toFixed(2),
    tax: tax.toFixed(2),
    resortFee: resortFee.toFixed(2),
    total: (subtotal + tax + resortFee).toFixed(2),
    seasonFactor: propConfig.seasonFactor,
  };
}

async function runInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Running room availability inquiry', {
    inquiryId,
    property: data.property,
    roomType: data.roomType,
    service: 'customer-beb4d43e-hospitality',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const propConfig = PROPERTIES[data.property];
    if (!propConfig) {
      const err = new Error(`Unknown property: ${data.property}`);
      err.name = 'PropertyNotFoundError';
      err.code = 'PROPERTY_NOT_FOUND';
      throw err;
    }

    const roomDef = ROOM_CATALOG[data.roomType];
    if (!roomDef) {
      const err = new Error(`Unknown room type: ${data.roomType}`);
      err.name = 'RoomTypeError';
      err.code = 'INVALID_ROOM_TYPE';
      throw err;
    }

    const rooms = [{ ...roomDef, available: INVENTORY[data.property][data.roomType] || 0 }];
    const bookingMetrics = computeBookingMetrics(rooms, data.property);
    const stayTotal = calculateStayTotal(roomDef.nightlyRate, data.nights || 3, data.property);

    const duration = Date.now() - startTime;

    incrementMetric('inquiry.success', {
      route: '/api/beb4d43e/inquiry',
      property: data.property,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/beb4d43e/inquiry',
    });

    return {
      success: true,
      inquiryId,
      property: propConfig.name,
      roomType: data.roomType,
      metrics: bookingMetrics[0],
      stayEstimate: stayTotal,
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('inquiry.failure', {
      route: '/api/beb4d43e/inquiry',
      errorClass: error.name,
      property: data.property,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/beb4d43e/inquiry',
      error: 'true',
    });

    logger.error('Room availability inquiry failed', {
      inquiryId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      property: data.property,
      roomType: data.roomType,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/beb4d43e/inquiry',
        service: 'customer-beb4d43e-hospitality',
        property: data.property,
      },
      extra: {
        inquiryId,
        property: data.property,
        roomType: data.roomType,
      },
    });

    createSessionAndAlert({
      customer: 'beb4d43e',
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/beb4d43e.js — runInquiry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      slackMemberId: 'U08S7AVJ478',
      service: 'customer-beb4d43e-hospitality',
      verticalLabel: 'Room Inquiry',
      tags: [
        { key: 'route', value: '/api/beb4d43e/inquiry' },
        { key: 'service', value: 'customer-beb4d43e-hospitality' },
        { key: 'property', value: data.property },
      ],
      extra: { inquiryId, property: data.property, roomType: data.roomType },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'acme-checkout@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from inquiry error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { runInquiry, PROPERTIES, ROOM_CATALOG, INVENTORY, getRoomAvailability, computeBookingMetrics, calculateStayTotal };
