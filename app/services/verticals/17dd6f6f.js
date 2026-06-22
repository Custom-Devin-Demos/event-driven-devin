const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Active shipments tracked by the logistics portal.
 */
const SHIPMENTS = [
  {
    trackingNumber: 'FX-7829104563',
    serviceType: 'priority_overnight',
    origin: { city: 'Memphis', state: 'TN', zip: '38116' },
    destination: { city: 'Columbus', state: 'OH', zip: '43004' },
    weightLbs: 12.4,
    dimsIn: { length: 18, width: 14, height: 10 },
    events: [
      { code: 'PU', description: 'Picked up', location: 'Memphis, TN', at: '2026-06-22T01:14:00Z' },
      { code: 'AR', description: 'Arrived at hub', location: 'Memphis, TN', at: '2026-06-22T03:40:00Z' },
      { code: 'DP', description: 'Departed hub', location: 'Memphis, TN', at: '2026-06-22T05:02:00Z' },
      { code: 'AR', description: 'Arrived at destination facility', location: 'Columbus, OH', at: '2026-06-22T11:18:00Z' },
    ],
  },
  {
    trackingNumber: 'FX-5510398822',
    serviceType: 'two_day',
    origin: { city: 'Dallas', state: 'TX', zip: '75201' },
    destination: { city: 'Denver', state: 'CO', zip: '80202' },
    weightLbs: 34.0,
    dimsIn: { length: 24, width: 18, height: 16 },
    events: [
      { code: 'PU', description: 'Picked up', location: 'Dallas, TX', at: '2026-06-21T22:05:00Z' },
      { code: 'AR', description: 'Arrived at hub', location: 'Fort Worth, TX', at: '2026-06-22T02:31:00Z' },
    ],
  },
];

/**
 * Service level configuration — drives transit commitments and which
 * delivery window each shipment is quoted against.
 */
const SERVICE_LEVELS = {
  priority_overnight: { label: 'Priority Overnight', transitDays: 1, cutoffHour: 10, windowKey: 'priority_overnight' },
  standard_overnight: { label: 'Standard Overnight', transitDays: 1, cutoffHour: 17, windowKey: 'standard_overnight' },
  two_day: { label: '2Day', transitDays: 2, cutoffHour: 17, windowKey: 'two_day' },
  ground: { label: 'Ground', transitDays: 5, cutoffHour: 23, windowKey: 'ground' },
};

/**
 * Promised delivery windows per service level. Used to render the
 * "delivery window" line on the tracking summary.
 */
const DELIVERY_WINDOWS = {
  priority_overnight: { start: '8:00 AM', end: '10:30 AM' },
  standard_overnight: { start: '8:00 AM', end: '3:00 PM' },
  two_day: { start: '9:00 AM', end: '8:00 PM' },
  ground: { start: '9:00 AM', end: '8:00 PM' },
};

const DEFAULT_DELIVERY_WINDOW = { start: '9:00 AM', end: '8:00 PM' };

function resolveShipment(trackingNumber) {
  return SHIPMENTS.find((s) => s.trackingNumber === trackingNumber) || SHIPMENTS[0];
}

/**
 * Dimensional vs. actual weight billing for a shipment.
 */
function computeShippingCost(shipment, level) {
  const { length, width, height } = shipment.dimsIn;
  const dimWeight = (length * width * height) / 139;
  const billableWeight = Math.max(shipment.weightLbs, dimWeight);
  const base = 18.5 + billableWeight * 1.35;
  const surcharge = level.transitDays <= 1 ? base * 0.45 : base * 0.12;
  return {
    billableWeight: Math.round(billableWeight * 10) / 10,
    totalCost: Math.round((base + surcharge) * 100) / 100,
  };
}

/**
 * Build the delivery estimate for a shipment given its service level.
 */
function buildDeliveryEstimate(shipment, level) {
  const transitDays = level.transitDays;
  const guaranteedBy = transitDays <= 1 ? 'next business day' : `${transitDays} business days`;
  const estimatedDelivery = new Date(Date.now() + transitDays * 86400000).toISOString().slice(0, 10);

  return {
    guaranteedBy,
    estimatedDelivery,
    transitDays,
    deliveryWindow: DELIVERY_WINDOWS[level.windowKey] || DEFAULT_DELIVERY_WINDOW,
  };
}

/**
 * Assemble the customer-facing tracking summary shown in the portal.
 */
function buildTrackingSummary(shipment, cost, estimate, history) {
  const latestEvent = history[history.length - 1];

  return {
    trackingNumber: shipment.trackingNumber,
    serviceLevel: SERVICE_LEVELS[shipment.serviceType].label,
    guaranteedBy: estimate.guaranteedBy,
    estimatedDelivery: estimate.estimatedDelivery,
    transitDays: estimate.transitDays,
    deliveryWindow: estimate.deliveryWindow.start + ' - ' + estimate.deliveryWindow.end,
    billableWeight: cost.billableWeight + ' lbs',
    totalCost: '$' + cost.totalCost.toFixed(2),
    lastScan: latestEvent.description + ' at ' + latestEvent.location,
    scanCount: history.length,
  };
}

/**
 * Processes a shipment tracking request.
 */
async function processTrackShipment(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Building shipment tracking summary', {
    requestId,
    trackingNumber: data.trackingNumber,
    service: 'customer-17dd6f6f-logistics',
    route: '/api/17dd6f6f/track-shipment',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const shipment = resolveShipment(data.trackingNumber);
    const level = SERVICE_LEVELS[shipment.serviceType];
    const cost = computeShippingCost(shipment, level);
    const estimate = buildDeliveryEstimate(shipment, level);
    const history = shipment.events;
    const summary = buildTrackingSummary(shipment, cost, estimate, history);

    summary.requestId = requestId;
    summary.generatedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('track_shipment.success', {
      route: '/api/17dd6f6f/track-shipment',
      serviceType: shipment.serviceType,
    });
    recordTiming('track_shipment.latency', duration, {
      route: '/api/17dd6f6f/track-shipment',
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('track_shipment.failure', {
      route: '/api/17dd6f6f/track-shipment',
      errorClass: error.name,
    });
    recordTiming('track_shipment.latency', duration, {
      route: '/api/17dd6f6f/track-shipment',
      error: 'true',
    });

    logger.error('Shipment tracking failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      trackingNumber: data.trackingNumber,
      service: 'customer-17dd6f6f-logistics',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/17dd6f6f/track-shipment',
        service: 'customer-17dd6f6f-logistics',
        serviceType: data.serviceType,
      },
      extra: { requestId, trackingNumber: data.trackingNumber },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/17dd6f6f.js \u2014 buildTrackingSummary',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-17dd6f6f-logistics',
      verticalLabel: 'Shipment Tracking',
      customer: '17dd6f6f',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/17dd6f6f/track-shipment' },
        { key: 'service', value: 'customer-17dd6f6f-logistics' },
        { key: 'serviceType', value: data.serviceType },
      ],
      extra: { requestId, trackingNumber: data.trackingNumber },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-17dd6f6f-logistics@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for track-shipment error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  processTrackShipment,
  buildTrackingSummary,
  buildDeliveryEstimate,
  computeShippingCost,
  SHIPMENTS,
  SERVICE_LEVELS,
  DELIVERY_WINDOWS,
};
