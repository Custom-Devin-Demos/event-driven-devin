const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * ICRC relief supply catalog — life-saving materials dispatched to field operations.
 */
const CATALOG = [
  { id: 'ICRC-EMK', name: 'Emergency Medical Kit', price: 120.0, category: 'medical', unit: 'kit' },
  { id: 'ICRC-WPU', name: 'Water Purification Unit', price: 85.0, category: 'water-sanitation', unit: 'unit' },
  { id: 'ICRC-FFP', name: 'Family Food Parcel', price: 45.0, category: 'food', unit: 'parcel' },
  { id: 'ICRC-TBL', name: 'Thermal Blankets (pack of 10)', price: 60.0, category: 'shelter', unit: 'pack' },
  { id: 'ICRC-SHK', name: 'Emergency Shelter Kit', price: 150.0, category: 'shelter', unit: 'kit' },
  { id: 'ICRC-HYG', name: 'Hygiene Kit', price: 30.0, category: 'water-sanitation', unit: 'kit' },
];

/**
 * Field deployment zones and their logistics configuration.
 */
const DEPLOYMENT_ZONES = {
  gaza: { label: 'Gaza & the region', logisticsRate: 0.12, currency: 'CHF' },
  sudan: { label: 'Sudan', logisticsRate: 0.15, currency: 'CHF' },
  ukraine: { label: 'Ukraine', logisticsRate: 0.1, currency: 'CHF' },
  'dr-congo': { label: 'DR Congo', logisticsRate: 0.14, currency: 'CHF' },
};

/**
 * Mandatory field-logistics line automatically appended to every dispatch so
 * that in-country transport is funded alongside the supplies themselves.
 */
const DISPATCH_LINES = [
  { sku: 'ICRC-LOG-2026', qty: 1, price: 0 },
];

/**
 * Priority handling tiers based on the value of the consignment.
 */
function getPriorityTier(subtotal) {
  if (subtotal >= 500) return { rate: 0.0, label: 'Priority airlift (waived)' };
  if (subtotal >= 200) return { rate: 0.03, label: 'Expedited road convoy' };
  return { rate: 0.05, label: 'Standard convoy' };
}

/**
 * Appends the mandatory field-logistics line to the requested supplies.
 */
function applyDispatchLines(items) {
  return [...items, ...DISPATCH_LINES];
}

/**
 * Computes the funded total for a relief consignment.
 */
function computeConsignmentTotal(subtotal, zoneId) {
  const zone = DEPLOYMENT_ZONES[zoneId];
  if (!zone) {
    throw Object.assign(new Error(`Unknown deployment zone: ${zoneId}`), { code: 'INVALID_ZONE' });
  }
  const logistics = subtotal * zone.logisticsRate;
  const priority = getPriorityTier(subtotal);
  const priorityFee = (subtotal + logistics) * priority.rate;
  return {
    subtotal,
    logistics: Math.round(logistics * 100) / 100,
    priorityFee: Math.round(priorityFee * 100) / 100,
    priorityLabel: priority.label,
    total: Math.round((subtotal + logistics + priorityFee) * 100) / 100,
    currency: zone.currency,
    zone: zone.label,
  };
}

/**
 * Builds the dispatch manifest for the order confirmation.
 * BUG: ICRC-LOG-2026 is not in CATALOG, so product.name crashes with a TypeError.
 */
function formatManifest(allItems) {
  return allItems.map((item) => {
    const product = CATALOG.find((p) => p.id === item.sku);
    return {
      sku: item.sku,
      name: product.name,
      category: product.category,
      qty: item.qty,
      lineTotal: item.price * item.qty,
    };
  });
}

/**
 * Processes an ICRC relief-supply order (checkout).
 */
async function processOrder(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing ICRC relief order', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'icrc-relief',
    route: '/api/9309cd53/checkout',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyDispatchLines(orderData.items);

    const computedSubtotal = orderData.items.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    ) || orderData.subtotal;

    const result = computeConsignmentTotal(computedSubtotal, orderData.zone);
    const manifest = formatManifest(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/9309cd53/checkout',
      source: 'icrc-relief-store',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/9309cd53/checkout',
    });

    return {
      success: true,
      orderId,
      total: result.total,
      logistics: result.logistics,
      priorityFee: result.priorityFee,
      priorityLabel: result.priorityLabel,
      currency: result.currency,
      zone: result.zone,
      manifest,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/9309cd53/checkout',
      errorClass: error.name,
      source: 'icrc-relief-store',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/9309cd53/checkout',
      error: 'true',
    });

    logger.error('ICRC relief order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'icrc-relief',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/9309cd53/checkout',
        service: 'icrc-relief',
        source: 'icrc-relief-store',
      },
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        zone: orderData.zone,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/9309cd53.js \u2014 formatManifest',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'icrc-relief',
      verticalLabel: 'ICRC Relief Supplies',
      customer: '9309cd53',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/9309cd53/checkout' },
        { key: 'service', value: 'icrc-relief' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'icrc-relief@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from ICRC relief order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processOrder, computeConsignmentTotal, formatManifest, applyDispatchLines, CATALOG, DEPLOYMENT_ZONES };
