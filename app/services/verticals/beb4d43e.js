const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const PROPERTIES = [
  { code: 'maui', name: 'Sheraton Maui Resort & Spa', region: 'US-HI', totalRooms: 508, occupancyPct: 87 },
  { code: 'cancun', name: 'JW Marriott Cancún Resort', region: 'MX-QR', totalRooms: 448, occupancyPct: 92 },
  { code: 'bali', name: 'The Ritz-Carlton Bali', region: 'ID-BA', totalRooms: 313, occupancyPct: 78 },
  { code: 'dubai', name: 'Marriott Resort Palm Jumeirah', region: 'AE-DU', totalRooms: 608, occupancyPct: 95 },
  { code: 'maldives', name: 'The St. Regis Maldives', region: 'MV-MA', totalRooms: 77, occupancyPct: 99 },
];

const ROOM_CATALOG = [
  { sku: 'DLX-KING', type: 'suite', description: 'Deluxe King Suite', nightlyRate: 489.00, available: 12, minStay: 1, tier: 'premium' },
  { sku: 'OCN-VIEW', type: 'suite', description: 'Ocean View Suite', nightlyRate: 729.00, available: 6, minStay: 2, tier: 'luxury' },
  { sku: 'STD-DOUBLE', type: 'standard', description: 'Standard Double Room', nightlyRate: 249.00, available: 45, minStay: 1, tier: 'select' },
  { sku: 'PRES-SUITE', type: 'suite', description: 'Presidential Suite', nightlyRate: 2199.00, available: 1, minStay: 3, tier: 'luxury' },
  { sku: 'FAM-CONN', type: 'family', description: 'Family Connected Rooms', nightlyRate: 379.00, available: 18, minStay: 1, tier: 'premium' },
  { sku: 'BNG-POOL', type: 'bungalow', description: 'Pool Bungalow', nightlyRate: 1149.00, available: 4, minStay: 2, tier: 'luxury' },
  { sku: 'CLB-ACCESS', type: 'club', description: 'Club Level King', nightlyRate: 559.00, available: 22, minStay: 1, tier: 'premium' },
];

const PRIORITY_TIERS = {
  standard: { discountFactor: 1.0, surcharge: 0 },
  bonvoy_silver: { discountFactor: 0.95, surcharge: 0 },
  bonvoy_gold: { discountFactor: 0.88, surcharge: 0 },
  bonvoy_platinum: { discountFactor: 0.80, surcharge: 0 },
};

const PROPERTY_POLICIES = {
  maui: { maxGuests: 4, yieldMultiplier: 1.12, seasonalAdjust: 1.15 },
  cancun: { maxGuests: 4, yieldMultiplier: 1.05, seasonalAdjust: 1.08 },
  bali: { maxGuests: 3, yieldMultiplier: 0.95, seasonalAdjust: 1.20 },
  dubai: { maxGuests: 6, yieldMultiplier: 1.25, seasonalAdjust: 1.35 },
  maldives: { maxGuests: 2, yieldMultiplier: 1.40, seasonalAdjust: 1.50 },
};

function normalizeRoomQuery(sku) {
  if (!sku) return null;
  const cleaned = sku.trim().toUpperCase();
  const parts = cleaned.split('-');
  if (parts.length < 2) return null;
  return {
    category: parts[0],
    variant: parts.slice(1).join('-'),
  };
}

function resolveRooms(roomType, sku) {
  let rooms;
  if (sku) {
    const parsed = normalizeRoomQuery(sku);
    if (parsed) {
      rooms = ROOM_CATALOG.filter((r) => r.sku.toUpperCase().includes(parsed.variant));
    }
  }
  if (!rooms || rooms.length === 0) {
    rooms = ROOM_CATALOG.filter((r) => r.type === roomType);
  }
  return rooms;
}

function getRoomAvailability(propertyCode) {
  const policy = PROPERTY_POLICIES[propertyCode];
  const property = PROPERTIES.find((p) => p.code === propertyCode);
  return {
    inventory: {
      available: property.totalRooms * (1 - property.occupancyPct / 100),
      reserved: property.totalRooms * (property.occupancyPct / 100),
    },
    yieldRate: policy.yieldMultiplier,
  };
}

function computeBookingMetrics(rooms, propertyCode) {
  const availability = getRoomAvailability(propertyCode);
  return rooms.map((room) => {
    const adjustedRate = room.nightlyRate * availability.capacity.available;
    const belowThreshold = room.available < 5;
    return {
      sku: room.sku,
      description: room.description,
      currentAvailable: room.available,
      adjustedRate: Math.round(adjustedRate * 100) / 100,
      belowThreshold,
      tier: room.tier,
      nightlyRate: room.nightlyRate,
    };
  });
}

function calculateStayEstimate(bookingMetrics, tierConfig, propertyCode) {
  const availability = getRoomAvailability(propertyCode);
  const results = bookingMetrics.map((metric) => {
    const discountedRate = metric.adjustedRate * tierConfig.discountFactor;
    const seasonalRate = discountedRate * availability.capacity.reserved;
    const totalEstimate = seasonalRate + (metric.nightlyRate * tierConfig.surcharge);

    return {
      sku: metric.sku,
      room: metric.description,
      available: metric.currentAvailable,
      estimatedNightly: Math.round(discountedRate * 100) / 100,
      totalEstimate: Math.round(totalEstimate * 100) / 100,
      availability: metric.belowThreshold ? 'LIMITED' : 'AVAILABLE',
      tier: metric.tier,
    };
  });

  return results;
}

function buildBookingResponse(stayData, property, priority) {
  const limitedRooms = stayData.filter((s) => s.availability === 'LIMITED');
  const totalAvailable = stayData.reduce((sum, s) => sum + s.available, 0);
  const avgRate = stayData.reduce((sum, s) => sum + s.estimatedNightly, 0) / stayData.length;

  return {
    property: property.name,
    propertyCode: property.code,
    region: property.region,
    availableRooms: totalAvailable,
    avgNightlyRate: Math.round(avgRate * 100) / 100,
    limitedAvailability: limitedRooms.length,
    priority,
    rooms: stayData.map((s) => ({
      sku: s.sku,
      room: s.room,
      available: s.available,
      nightly: s.estimatedNightly,
      status: s.availability,
    })),
    recommendations: [],
  };
}

async function runInquiry(data) {
  const startTime = Date.now();
  const inquiryId = uuidv4();

  logger.info('Processing room availability inquiry', {
    inquiryId,
    property: data.property,
    roomType: data.roomType,
    priority: data.priority,
    service: 'customer-beb4d43e-hospitality',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const property = PROPERTIES.find((p) => p.code === data.property);
    const rooms = resolveRooms(data.roomType, data.sku);
    const bookingMetrics = computeBookingMetrics(rooms, data.property);
    const tierConfig = PRIORITY_TIERS[data.priority];
    const stayEstimate = calculateStayEstimate(bookingMetrics, tierConfig, data.property);
    const response = buildBookingResponse(stayEstimate, property, data.priority);

    response.inquiryId = inquiryId;
    response.completedAt = new Date().toISOString();

    if (response.limitedAvailability > 0) {
      response.recommendations.push('Consider upgrading to Club Level for guaranteed availability');
      response.recommendations.push('Book early to secure limited room types');
    }
    if (response.avgNightlyRate > 1000) {
      response.recommendations.push('Bonvoy Platinum members receive complimentary suite upgrades');
    }

    const duration = Date.now() - startTime;

    incrementMetric('inquiry.success', {
      route: '/api/beb4d43e/inquiry',
      property: data.property,
    });
    recordTiming('inquiry.latency', duration, {
      route: '/api/beb4d43e/inquiry',
    });

    return response;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('inquiry.failure', {
      route: '/api/beb4d43e/inquiry',
      errorClass: error.name,
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
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/beb4d43e/inquiry',
        service: 'customer-beb4d43e-hospitality',
        property: data.property,
      },
      extra: { inquiryId, property: data.property, roomType: data.roomType },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/beb4d43e.js \u2014 runInquiry',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-beb4d43e-hospitality',
      verticalLabel: 'Room Availability Inquiry',
      customer: 'beb4d43e',
      slackMemberId: 'U08S7AVJ478',
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
      release: process.env.SENTRY_RELEASE || 'customer-beb4d43e-hospitality@4.2.1',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for room inquiry error', {
        error: err.message,
        inquiryId,
      });
    });

    throw error;
  }
}

module.exports = { runInquiry, PROPERTIES, ROOM_CATALOG };
