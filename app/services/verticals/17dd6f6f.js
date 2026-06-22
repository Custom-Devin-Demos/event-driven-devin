const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SHIPMENTS = [
  {
    trackingNumber: 'FX-7829104563',
    serviceType: 'priority_overnight',
    origin: { city: 'Memphis', state: 'TN', zip: '38118', facility: 'MEM-HUB' },
    destination: { city: 'Seattle', state: 'WA', zip: '98101', facility: null },
    weight: { value: 12.4, unit: 'lbs' },
    dimensions: { length: 18, width: 12, height: 8 },
    status: 'in_transit',
  },
  {
    trackingNumber: 'FX-3351908274',
    serviceType: 'ground_economy',
    origin: { city: 'Indianapolis', state: 'IN', zip: '46241', facility: 'IND-SORT' },
    destination: { city: 'Austin', state: 'TX', zip: '78701', facility: 'AUS-DIST' },
    weight: { value: 34.7, unit: 'lbs' },
    dimensions: { length: 24, width: 18, height: 14 },
    status: 'delivered',
  },
];

const SERVICE_LEVELS = {
  priority_overnight: { label: 'FedEx Priority Overnight', maxTransitDays: 1, surchargeRate: 0.12, guaranteedBy: '10:30 AM' },
  standard_overnight: { label: 'FedEx Standard Overnight', maxTransitDays: 1, surchargeRate: 0.08, guaranteedBy: '3:00 PM' },
  two_day: { label: 'FedEx 2Day', maxTransitDays: 2, surchargeRate: 0.05, guaranteedBy: null },
  ground_economy: { label: 'FedEx Ground Economy', maxTransitDays: 7, surchargeRate: 0.0, guaranteedBy: null },
};

const SCAN_EVENTS = [
  { code: 'PU', label: 'Picked up', timestamp: '2026-06-20T14:22:00Z', location: 'Memphis, TN' },
  { code: 'DP', label: 'Departed facility', timestamp: '2026-06-20T18:45:00Z', location: 'Memphis, TN' },
  { code: 'AR', label: 'Arrived at sort facility', timestamp: '2026-06-21T02:10:00Z', location: 'Salt Lake City, UT' },
  { code: 'IT', label: 'In transit', timestamp: '2026-06-21T06:30:00Z', location: 'Boise, ID' },
  { code: 'OD', label: 'Out for delivery', timestamp: '2026-06-22T08:15:00Z', location: 'Seattle, WA' },
];

function resolveShipment(trackingNumber) {
  return SHIPMENTS.find((s) => s.trackingNumber === trackingNumber) || SHIPMENTS[0];
}

function computeShippingCost(shipment) {
  const service = SERVICE_LEVELS[shipment.serviceType];
  const dimWeight = (shipment.dimensions.length * shipment.dimensions.width * shipment.dimensions.height) / 139;
  const billableWeight = Math.max(shipment.weight.value, dimWeight);
  const baseCost = billableWeight * 1.45;
  const surcharge = baseCost * service.surchargeRate;
  return {
    baseCost: Math.round(baseCost * 100) / 100,
    surcharge: Math.round(surcharge * 100) / 100,
    totalCost: Math.round((baseCost + surcharge) * 100) / 100,
    billableWeight: Math.round(billableWeight * 10) / 10,
  };
}

function buildDeliveryEstimate(shipment) {
  const service = SERVICE_LEVELS[shipment.serviceType];
  const pickupDate = new Date('2026-06-20T14:22:00Z');
  const estimatedDelivery = new Date(pickupDate);
  estimatedDelivery.setDate(estimatedDelivery.getDate() + service.maxTransitDays);

  const estimate = {
    serviceLabel: service.label,
    guaranteedBy: service.guaranteedBy,
    estimatedDelivery: estimatedDelivery.toISOString(),
    transitDays: service.maxTransitDays,
  };

  estimate.deliveryWindow = {
    start: '8:00 AM',
    end: service.guaranteedBy || '8:00 PM',
    facility: shipment.destination.facility || null,
  };

  return estimate;
}

function getTrackingHistory(shipment) {
  return SCAN_EVENTS.map((evt) => ({
    code: evt.code,
    description: evt.label,
    timestamp: evt.timestamp,
    location: evt.location,
    facility: shipment.origin.facility,
  }));
}

function buildTrackingSummary(shipment, cost, estimate, history) {
  const latestEvent = history[history.length - 1];

  return {
    trackingNumber: shipment.trackingNumber,
    status: shipment.status,
    origin: `${shipment.origin.city}, ${shipment.origin.state} ${shipment.origin.zip}`,
    destination: `${shipment.destination.city}, ${shipment.destination.state} ${shipment.destination.zip}`,
    service: estimate.serviceLabel,
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

async function processTrackShipment(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing shipment tracking request', {
    requestId,
    trackingNumber: data.trackingNumber,
    service: 'customer-17dd6f6f-logistics',
    route: '/api/17dd6f6f/track-shipment',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const shipment = resolveShipment(data.trackingNumber);
    const cost = computeShippingCost(shipment);
    const estimate = buildDeliveryEstimate(shipment);
    const history = getTrackingHistory(shipment);
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

    logger.error('Shipment tracking request failed', {
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
      logger.error('Failed to create Devin session for shipment tracking error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = {
  processTrackShipment,
  buildDeliveryEstimate,
  buildTrackingSummary,
  computeShippingCost,
  getTrackingHistory,
  SHIPMENTS,
  SERVICE_LEVELS,
  SCAN_EVENTS,
};
