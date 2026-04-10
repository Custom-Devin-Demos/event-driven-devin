const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Product catalog for the CPG distributor portal
 */
const CATALOG = [
  { sku: 'BEV-001', name: 'Sparkling Water (24pk)', category: 'beverages', unitPrice: 18.99, caseWeight: 22.5 },
  { sku: 'BEV-002', name: 'Organic Juice (12pk)', category: 'beverages', unitPrice: 32.50, caseWeight: 18.0 },
  { sku: 'SNK-001', name: 'Granola Bars (48ct)', category: 'snacks', unitPrice: 24.99, caseWeight: 8.5 },
  { sku: 'SNK-002', name: 'Trail Mix (36ct)', category: 'snacks', unitPrice: 42.00, caseWeight: 12.0 },
  { sku: 'HHL-001', name: 'Dish Soap (12pk)', category: 'household', unitPrice: 28.75, caseWeight: 15.0 },
  { sku: 'HHL-002', name: 'Paper Towels (30ct)', category: 'household', unitPrice: 36.99, caseWeight: 20.0 },
  { sku: 'FRZ-001', name: 'Frozen Meals (24ct)', category: 'frozen', unitPrice: 54.00, caseWeight: 25.0 },
  { sku: 'DRY-001', name: 'Cereal Variety (18pk)', category: 'dry goods', unitPrice: 38.50, caseWeight: 10.0 },
];

/**
 * Warehouse tiers by region — capacity, hubs, and minimum order sizes.
 */
const WAREHOUSE_TIERS = [
  { region: 'northeast', hubs: ['NYC', 'BOS', 'PHL'], capacity: 50000, minOrder: 100 },
  { region: 'southeast', hubs: ['ATL', 'MIA', 'CLT'], capacity: 35000, minOrder: 75 },
  { region: 'midwest',   hubs: ['CHI', 'DET', 'MSP'], capacity: 40000, minOrder: 80 },
  { region: 'west',      hubs: ['LAX', 'SEA', 'DEN'], capacity: 45000, minOrder: 90 },
];

/**
 * Ranks warehouses by available capacity for a given fulfillment zone,
 * returning a sorted list of options with rank metadata.
 */
function rankWarehouses(fulfillmentZone) {
  const sorted = [...WAREHOUSE_TIERS].sort((a, b) => b.capacity - a.capacity);

  return sorted.map((tier, index) => ({
    region: tier.region,
    primaryHub: tier.hubs[0],
    capacity: tier.capacity,
    rank: index + 1,
    isPreferred: tier.region === fulfillmentZone,
  }));
}

/**
 * Selects the best fulfillment option from the ranked warehouse list.
 */
function selectFulfillmentHub(fulfillmentZone) {
  const options = rankWarehouses(fulfillmentZone);
  const preferred = options.find((o) => o.isPreferred);
  const selected = preferred || options[0];
  return { selected, alternatives: options.filter((o) => o !== selected) };
}

/**
 * Build a shipping manifest from the selected fulfillment hub.
 */
function buildShippingManifest(hub, orderItems) {
  const totalUnits = orderItems.reduce((sum, item) => sum + item.qty, 0);
  const hubCode = hub.origin.code.substring(0, 3);
  return {
    originHub: hubCode,
    capacity: hub.capacity,
    totalUnits,
    estimatedDays: totalUnits > 200 ? 5 : 3,
  };
}

/**
 * Process a distributor bulk order.
 */
async function processOrder(orderData) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing distributor order', {
    orderId,
    distributorId: orderData.distributorId,
    region: orderData.region,
    fulfillmentZone: orderData.fulfillmentZone,
    itemCount: orderData.items ? orderData.items.length : 0,
    service: 'cpg-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const fulfillment = selectFulfillmentHub(orderData.fulfillmentZone);
    const manifest = buildShippingManifest(fulfillment, orderData.items);

    const subtotal = orderData.items.reduce((sum, item) => {
      const product = CATALOG.find((p) => p.sku === item.sku);
      return sum + (product ? product.unitPrice * item.qty : 0);
    }, 0);

    const totalWeight = orderData.items.reduce((sum, item) => {
      const product = CATALOG.find((p) => p.sku === item.sku);
      return sum + (product ? product.caseWeight * item.qty : 0);
    }, 0);

    const duration = Date.now() - startTime;

    incrementMetric('order.success', {
      route: '/api/cpg/order',
      region: orderData.region,
    });
    recordTiming('order.latency', duration, {
      route: '/api/cpg/order',
    });

    return {
      success: true,
      orderId,
      distributorId: orderData.distributorId,
      subtotal: Math.round(subtotal * 100) / 100,
      totalWeight: Math.round(totalWeight * 10) / 10,
      availableCapacity: manifest.capacity,
      fulfillmentHub: manifest.originHub,
      leadTimeDays: manifest.estimatedDays,
      status: 'confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('order.failure', {
      route: '/api/cpg/order',
      errorClass: error.name,
    });
    recordTiming('order.latency', duration, {
      route: '/api/cpg/order',
      error: 'true',
    });

    logger.error('Distributor order failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      distributorId: orderData.distributorId,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/cpg/order',
        service: 'cpg-api',
        region: orderData.region,
      },
      extra: { orderId, distributorId: orderData.distributorId },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/cpg.js — selectFulfillmentHub',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: orderData.devinUserId,
      devinOrgId: orderData.devinOrgId,
      service: 'cpg-api',
      verticalLabel: 'Distributor Order',
      tags: [
        { key: 'route', value: '/api/cpg/order' },
        { key: 'service', value: 'cpg-api' },
      ],
      extra: { orderId, distributorId: orderData.distributorId, region: orderData.region },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'harvest-goods@1.0.2',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processOrder, CATALOG, WAREHOUSE_TIERS };
