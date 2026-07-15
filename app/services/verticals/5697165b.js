const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Shipping method catalog. Each method defines the delivery zones
 * it can be offered in.
 */
const SHIPPING_METHODS = [
  { id: 'standard', label: 'Standard Shipping', zones: [1, 2, 3, 4, 5], baseDays: 5 },
  { id: 'express', label: 'Express Shipping', zones: [1, 2, 3], baseDays: 2 },
  { id: 'next-day', label: 'Next Business Day', zones: [1, 2], baseDays: 1 },
];

/**
 * Carrier rate sheet by delivery zone. Base rates and transit
 * adjustments negotiated per zone with the fulfillment network.
 */
const ZONE_RATES = {
  1: { baseRate: 0, transitDays: 0, cutoffHour: 17 },
  2: { baseRate: 4.95, transitDays: 1, cutoffHour: 16 },
  3: { baseRate: 9.95, transitDays: 2, cutoffHour: 15 },
  5: { baseRate: 24.95, transitDays: 4, cutoffHour: 12 },
};

/**
 * Region to delivery zone mapping used to resolve a shopper's
 * shipping destination.
 */
const REGION_ZONES = {
  'west-coast': 1,
  mountain: 2,
  midwest: 3,
  'east-coast': 3,
  'alaska-hawaii': 4,
  'us-territories': 5,
};

function findMethod(methodId) {
  return SHIPPING_METHODS.find((m) => m.id === methodId) || SHIPPING_METHODS[0];
}

/**
 * Build the rate table for a shipping method across its supported
 * zones. Only zones present in the carrier rate sheet are included
 * in the table — zones without negotiated rates are skipped.
 */
function buildRateTable(method) {
  const table = {};

  for (const zone of method.zones) {
    const rates = ZONE_RATES[zone];

    if (rates) {
      table[zone] = {
        zone,
        baseRate: rates.baseRate,
        transitDays: rates.transitDays,
        cutoffHour: rates.cutoffHour,
      };
    }
  }

  return table;
}

/**
 * Compute the delivery quote for the destination zone from the
 * method's rate table.
 */
function computeDeliveryQuote(method, table, zone, orderTotal) {
  const entry = table[zone];
  const freeShipThreshold = 89;
  const shippingCost = orderTotal >= freeShipThreshold && method.id === 'standard' ? 0 : entry.baseRate;
  const deliveryDays = method.baseDays + entry.transitDays;

  return { zone, shippingCost, deliveryDays, cutoffHour: entry.cutoffHour };
}

/**
 * Assemble the final delivery estimate returned to the client.
 */
function assembleEstimate(method, quote, data) {
  const arrival = new Date();
  arrival.setDate(arrival.getDate() + quote.deliveryDays);

  return {
    estimateId: `NORD-${uuidv4().slice(0, 8).toUpperCase()}`,
    method: method.label,
    shippingCost: quote.shippingCost,
    deliveryDays: quote.deliveryDays,
    estimatedArrival: arrival.toISOString().slice(0, 10),
    orderCutoff: `${quote.cutoffHour}:00 local time`,
    orderTotal: data.orderTotal,
    currency: 'USD',
    freeReturns: true,
  };
}

/**
 * Processes a delivery estimate request for an online order.
 */
async function processDeliveryEstimate(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Processing delivery estimate request', {
    requestId,
    methodId: data.methodId,
    region: data.region,
    orderTotal: data.orderTotal,
    service: 'customer-5697165b-retail',
    route: '/api/5697165b/delivery-estimate',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const method = findMethod(data.methodId);
    const zone = REGION_ZONES[data.region] || 3;
    const table = buildRateTable(method);
    const quote = computeDeliveryQuote(method, table, zone, data.orderTotal);
    const estimate = assembleEstimate(method, quote, data);

    estimate.requestId = requestId;
    estimate.quotedAt = new Date().toISOString();

    const duration = Date.now() - startTime;

    incrementMetric('delivery_estimate.success', {
      route: '/api/5697165b/delivery-estimate',
      method: method.id,
    });
    recordTiming('delivery_estimate.latency', duration, {
      route: '/api/5697165b/delivery-estimate',
    });

    return estimate;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('delivery_estimate.failure', {
      route: '/api/5697165b/delivery-estimate',
      errorClass: error.name,
    });
    recordTiming('delivery_estimate.latency', duration, {
      route: '/api/5697165b/delivery-estimate',
      error: 'true',
    });

    logger.error('Delivery estimate request failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      methodId: data.methodId,
      region: data.region,
      service: 'customer-5697165b-retail',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/5697165b/delivery-estimate',
        service: 'customer-5697165b-retail',
        method: data.methodId,
      },
      extra: { requestId, region: data.region, orderTotal: data.orderTotal },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/5697165b.js — computeDeliveryQuote',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'customer-5697165b-retail',
      verticalLabel: 'Delivery Estimate',
      customer: '5697165b',
      tags: [
        { key: 'route', value: '/api/5697165b/delivery-estimate' },
        { key: 'service', value: 'customer-5697165b-retail' },
        { key: 'method', value: data.methodId },
      ],
      extra: { requestId, region: data.region, orderTotal: data.orderTotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-5697165b-retail@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to create Devin session for delivery estimate error', {
        error: err.message,
        requestId,
      });
    });

    throw error;
  }
}

module.exports = { processDeliveryEstimate, SHIPPING_METHODS, ZONE_RATES, REGION_ZONES };
