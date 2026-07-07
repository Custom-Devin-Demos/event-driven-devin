const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const DISTRIBUTION_NETWORK = [
  { code: 'PLT-FREMONT-OH', name: 'Fremont, OH Plant', region: 'midwest', onHand: 128400, daysOfSupply: 18.6, status: 'optimal' },
  { code: 'DC-HOLLAND', name: 'Holland, MI Distribution Center', region: 'midwest', onHand: 21850, daysOfSupply: 4.2, status: 'low' },
  { code: 'DC-MASON', name: 'Mason City, IA Distribution Center', region: 'midwest', onHand: 7420, daysOfSupply: 2.1, status: 'critical' },
  { code: 'DC-NEWBERRY', name: 'Newberry, SC Distribution Center', region: 'southeast', onHand: 39100, daysOfSupply: 10.4, status: 'optimal' },
  { code: 'DC-DAVENPORT', name: 'Davenport, IA Distribution Center', region: 'midwest', onHand: 16230, daysOfSupply: 3.8, status: 'low' },
  { code: 'PLT-CHAMPAIGN', name: 'Champaign, IL Plant', region: 'midwest', onHand: 88600, daysOfSupply: 14.1, status: 'optimal' },
];

const SHIPPING_LANES = [
  { originPlant: 'PLT-FREMONT-OH', destinationDc: 'DC-HOLLAND', transitDays: 1, mode: 'truckload', costPerPallet: 84.5 },
  { originPlant: 'PLT-FREMONT-OH', destinationDc: 'DC-NEWBERRY', transitDays: 2, mode: 'truckload', costPerPallet: 132.0 },
  { originPlant: 'PLT-CHAMPAIGN', destinationDc: 'DC-DAVENPORT', transitDays: 1, mode: 'truckload', costPerPallet: 66.25 },
  { originPlant: 'PLT-CHAMPAIGN', destinationDc: 'DC-NEWBERRY', transitDays: 3, mode: 'rail', costPerPallet: 118.0 },
  { originPlant: 'PLT-FREMONT-OH', destinationDc: 'DC-DAVENPORT', transitDays: 2, mode: 'truckload', costPerPallet: 97.5 },
  { originPlant: 'PLT-CHAMPAIGN', destinationDc: 'DC-HOLLAND', transitDays: 1, mode: 'truckload', costPerPallet: 71.75 },
];

/**
 * BUG: the Mason City DC was opened in the UI before its lane master entries were
 * created, so no SHIPPING_LANES row exists for any origin into DC-MASON (the default
 * form pair). resolveLane returns undefined for those pairs and the crash surfaces
 * later in planReplenishment. Every non-Mason origin/destination pair resolves fine.
 */
function resolveLane(originPlant, destinationDc) {
  return SHIPPING_LANES.find((lane) => lane.originPlant === originPlant && lane.destinationDc === destinationDc);
}

function buildConfirmation(data, lane) {
  return {
    orderId: `KH-REP-${Date.now()}`,
    originPlant: data.originPlant,
    destinationDc: data.destinationDc,
    sku: data.sku,
    quantity: Number(data.quantity || 0),
    transitDays: lane.transitDays,
    mode: lane.mode,
    costPerPallet: lane.costPerPallet.toFixed(2),
    scheduledShipDate: new Date(Date.now() + lane.transitDays * 86400000).toISOString(),
  };
}

function planReplenishment(data) {
  const lane = resolveLane(data.originPlant, data.destinationDc);
  const transitDays = lane.transitDays;
  const quantity = Number(data.quantity || 0);
  const confirmation = buildConfirmation(data, lane);

  return {
    success: true,
    orderId: confirmation.orderId,
    confirmation: {
      ...confirmation,
      quantity,
      transitDays,
      mode: lane.mode,
      costPerPallet: lane.costPerPallet.toFixed(2),
      scheduledShipDate: new Date(Date.now() + transitDays * 86400000).toISOString(),
    },
    status: 'released',
    processedAt: new Date().toISOString(),
  };
}

async function processReplenishment(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing replenishment order', {
    requestId,
    originPlant: data.originPlant,
    destinationDc: data.destinationDc,
    sku: data.sku,
    quantity: data.quantity,
    service: 'kraftheinz-supply-chain',
    route: '/api/058bcc4c/replenishment',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 110));

    const result = planReplenishment(data);
    const duration = Date.now() - startTime;

    incrementMetric('replenishment.success', {
      route: '/api/058bcc4c/replenishment',
      destinationDc: data.destinationDc || 'auto',
    });
    recordTiming('replenishment.latency', duration, {
      route: '/api/058bcc4c/replenishment',
    });

    return result;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('replenishment.failure', {
      route: '/api/058bcc4c/replenishment',
      errorClass: error.name,
    });
    recordTiming('replenishment.latency', duration, {
      route: '/api/058bcc4c/replenishment',
      error: 'true',
    });

    logger.error('Replenishment order failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      originPlant: data.originPlant,
      destinationDc: data.destinationDc,
      sku: data.sku,
      service: 'kraftheinz-supply-chain',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/058bcc4c/replenishment',
        service: 'kraftheinz-supply-chain',
      },
      extra: {
        requestId,
        originPlant: data.originPlant,
        destinationDc: data.destinationDc,
        sku: data.sku,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/058bcc4c.js — planReplenishment',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'kraftheinz-supply-chain',
      verticalLabel: 'Kraft Heinz Replenishment Order',
      customer: '058bcc4c',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/058bcc4c/replenishment' },
        { key: 'service', value: 'kraftheinz-supply-chain' },
      ],
      extra: {
        requestId,
        originPlant: data.originPlant,
        destinationDc: data.destinationDc,
        sku: data.sku,
      },
      level: 'error',
      platform: 'node',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'kraftheinz-supply-chain@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      firstSeen: '',
      count: '',
      shortId: '',
      triggeredRule: '',
      lastSeen: new Date().toISOString(),
    }).catch((err) => logger.error('Failed to trigger Devin session from replenishment error', { error: err.message, requestId }));

    throw error;
  }
}

module.exports = {
  processReplenishment,
  planReplenishment,
  resolveLane,
  DISTRIBUTION_NETWORK,
  SHIPPING_LANES,
  buildConfirmation,
};
