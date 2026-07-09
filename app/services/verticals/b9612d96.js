const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Croda specialty-ingredient catalogue — sample-sized quantities of the
 * high-performance ingredients that customers order for formulation trials.
 */
const CATALOG = [
  { id: 'CRODA-CRM-GTCC', name: 'Crodamol\u2122 GTCC', price: 42.0, category: 'Consumer Care', unit: '500 ml' },
  { id: 'CRODA-CIT-10GTIS', name: 'Cithrol\u2122 10GTIS', price: 58.0, category: 'Consumer Care', unit: '1 kg' },
  { id: 'CRODA-SOL-CT100', name: 'Solaveil\u2122 CT-100', price: 76.0, category: 'Consumer Care', unit: '1 kg' },
  { id: 'CRODA-SR-PEG400', name: 'Super Refined\u2122 PEG 400', price: 95.0, category: 'Life Sciences', unit: '2 kg' },
  { id: 'CRODA-ATX-4913', name: 'Atlox\u2122 4913', price: 64.0, category: 'Crop Care', unit: '1 kg' },
  { id: 'CRODA-BRIJ-O10', name: 'Brij\u2122 O10', price: 38.0, category: 'Industrial Specialties', unit: '1 kg' },
];

/**
 * Manufacturing / distribution sites a sample consignment can ship from,
 * each with its own outbound freight rate.
 */
const DISPATCH_SITES = {
  'rawcliffe-bridge': { label: 'Rawcliffe Bridge, UK', freightRate: 0.09, currency: 'GBP' },
  mevisa: { label: 'Mevisa, Spain', freightRate: 0.11, currency: 'GBP' },
  'atlas-point': { label: 'Atlas Point, USA', freightRate: 0.14, currency: 'GBP' },
  singapore: { label: 'Singapore', freightRate: 0.16, currency: 'GBP' },
};

/**
 * Mandatory cold-chain handling line automatically appended to every sample
 * consignment so temperature-sensitive actives stay within spec in transit.
 */
const HANDLING_LINES = [
  { sku: 'CRODA-COLD-2026', qty: 1, price: 0 },
];

/**
 * Priority-handling tiers based on the value of the consignment.
 */
function getPriorityTier(subtotal) {
  if (subtotal >= 400) return { rate: 0.0, label: 'Priority air freight (waived)' };
  if (subtotal >= 150) return { rate: 0.03, label: 'Expedited courier' };
  return { rate: 0.05, label: 'Standard ground' };
}

/**
 * Appends the mandatory cold-chain handling line to the requested samples.
 */
function applyHandlingLines(items) {
  return [...items, ...HANDLING_LINES];
}

/**
 * Computes the invoiced total for a sample consignment.
 */
function computeConsignmentTotal(subtotal, siteId) {
  const site = DISPATCH_SITES[siteId];
  if (!site) {
    throw Object.assign(new Error(`Unknown dispatch site: ${siteId}`), { code: 'INVALID_SITE' });
  }
  const freight = subtotal * site.freightRate;
  const priority = getPriorityTier(subtotal);
  const priorityFee = (subtotal + freight) * priority.rate;
  return {
    subtotal,
    freight: Math.round(freight * 100) / 100,
    priorityFee: Math.round(priorityFee * 100) / 100,
    priorityLabel: priority.label,
    total: Math.round((subtotal + freight + priorityFee) * 100) / 100,
    currency: site.currency,
    site: site.label,
  };
}

/**
 * Builds the dispatch manifest for the order confirmation.
 * BUG: CRODA-COLD-2026 is not in CATALOG, so product.name crashes with a TypeError.
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
 * Processes a Croda specialty-ingredient sample dispatch.
 */
async function processDispatch(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing Croda sample dispatch', {
    orderId,
    userId: orderData.userId,
    subtotal: orderData.subtotal,
    service: 'croda-samples',
    route: '/api/b9612d96/dispatch',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const allItems = applyHandlingLines(orderData.items);

    const computedSubtotal = orderData.items.reduce(
      (sum, item) => sum + item.price * item.qty,
      0,
    ) || orderData.subtotal;

    const result = computeConsignmentTotal(computedSubtotal, orderData.site);
    const manifest = formatManifest(allItems);

    const duration = Date.now() - startTime;

    incrementMetric('checkout.success', {
      route: '/api/b9612d96/dispatch',
      source: 'croda-sample-store',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/b9612d96/dispatch',
    });

    return {
      success: true,
      orderId,
      total: result.total,
      freight: result.freight,
      priorityFee: result.priorityFee,
      priorityLabel: result.priorityLabel,
      currency: result.currency,
      site: result.site,
      manifest,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('checkout.failure', {
      route: '/api/b9612d96/dispatch',
      errorClass: error.name,
      source: 'croda-sample-store',
    });
    recordTiming('checkout.latency', duration, {
      route: '/api/b9612d96/dispatch',
      error: 'true',
    });

    logger.error('Croda sample dispatch failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      userId: orderData.userId,
      service: 'croda-samples',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/b9612d96/dispatch',
        service: 'croda-samples',
        source: 'croda-sample-store',
      },
      extra: {
        orderId,
        userId: orderData.userId,
        subtotal: orderData.subtotal,
        site: orderData.site,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b9612d96.js \u2014 formatManifest',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinEmail: orderData.devinEmail,
      devinOrgId: orderData.devinOrgId,
      service: 'croda-samples',
      verticalLabel: 'Croda Sample Dispatch',
      customer: 'b9612d96',
      slackMemberId: 'U08S7AVJ478',
      tags: [
        { key: 'route', value: '/api/b9612d96/dispatch' },
        { key: 'service', value: 'croda-samples' },
      ],
      extra: { orderId, userId: orderData.userId, subtotal: orderData.subtotal },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'croda-samples@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from Croda sample dispatch error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processDispatch, computeConsignmentTotal, formatManifest, applyHandlingLines, CATALOG, DISPATCH_SITES };
