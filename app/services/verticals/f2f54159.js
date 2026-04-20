const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

/**
 * Product catalog for the collectibles pre-order portal (Marvel Legends line)
 */
const PRODUCTS = [
  { sku: 'ML-001', name: 'Spider-Man Retro Collection', line: 'marvel-legends', price: 24.99, wave: 'retro', edition: 'standard' },
  { sku: 'ML-002', name: 'Wolverine Premium Figure', line: 'marvel-legends', price: 34.99, wave: 'premium', edition: 'deluxe' },
  { sku: 'ML-003', name: 'Iron Man Mark VII', line: 'marvel-legends', price: 29.99, wave: 'classic', edition: 'standard' },
  { sku: 'ML-004', name: 'Captain America Shield Edition', line: 'marvel-legends', price: 39.99, wave: 'premium', edition: 'exclusive' },
  { sku: 'ML-005', name: 'Black Panther Vibranium Series', line: 'marvel-legends', price: 27.99, wave: 'classic', edition: 'standard' },
  { sku: 'ML-006', name: 'Thor Mjolnir Edition', line: 'marvel-legends', price: 44.99, wave: 'premium', edition: 'deluxe' },
  { sku: 'ML-007', name: 'Deadpool Collector Set', line: 'marvel-legends', price: 49.99, wave: 'retro', edition: 'exclusive' },
  { sku: 'ML-008', name: 'Hulk Smash Series', line: 'marvel-legends', price: 32.99, wave: 'classic', edition: 'standard' },
];

/**
 * Warehouse locations by region for inventory fulfillment
 */
const WAREHOUSES = {
  northeast: { name: 'Providence Distribution Center', code: 'PVD-01', capacity: 25000 },
  southeast: { name: 'Atlanta Fulfillment Hub', code: 'ATL-02', capacity: 30000 },
  midwest: { name: 'Indianapolis Warehouse', code: 'IND-03', capacity: 20000 },
  west: { name: 'Phoenix Distribution Center', code: 'PHX-04', capacity: 22000 },
};

/**
 * Shipping methods and estimated delivery windows
 */
const SHIPPING_METHODS = {
  standard: { method: 'Standard Ground', days: 7, cost: 5.99 },
  express: { method: 'Express 2-Day', days: 2, cost: 12.99 },
  priority: { method: 'Priority Overnight', days: 1, cost: 24.99 },
};

/**
 * Pricing rules per edition type
 */
const PRICING_RULES = {
  standard: { discount: 0, preorderBonus: 0 },
  deluxe: { discount: 0.05, preorderBonus: 2.00 },
  exclusive: { discount: 0.10, preorderBonus: 5.00 },
};

/**
 * Look up a product by SKU from the catalog
 */
function lookupProduct(sku) {
  return PRODUCTS.find((p) => p.sku === sku);
}

/**
 * Check inventory availability for a product in a given region.
 * Returns inventory details including warehouse info and available stock.
 */
function checkInventory(product, region) {
  const warehouse = WAREHOUSES[region];
  const baseAllocation = Math.floor(Math.random() * 500) + 100;
  const reserved = Math.floor(Math.random() * 50);

  return {
    sku: product.sku,
    netAvailable: baseAllocation - reserved,
    allocated: baseAllocation,
    reserved,
    warehouse,
    region,
  };
}

/**
 * Calculate shipping details based on region and method preference
 */
function calculateShipping(region, shippingPreference) {
  const method = SHIPPING_METHODS[shippingPreference] || SHIPPING_METHODS.standard;
  const regionSurcharge = region === 'west' ? 2.00 : 0;
  return {
    method: method.method,
    estimatedDays: method.days,
    cost: method.cost + regionSurcharge,
  };
}

/**
 * Calculate pricing for a pre-order based on product edition and quantity
 */
function calculatePricing(product, quantity) {
  const rule = PRICING_RULES[product.edition] || PRICING_RULES.standard;
  const unitPrice = product.price * (1 - rule.discount);
  const subtotal = unitPrice * quantity;
  const preorderSavings = rule.preorderBonus * quantity;
  return {
    unitPrice: Math.round(unitPrice * 100) / 100,
    subtotal: Math.round(subtotal * 100) / 100,
    preorderSavings: Math.round(preorderSavings * 100) / 100,
    edition: product.edition,
  };
}

/**
 * Build the pre-order response payload from all computed data.
 */
function buildPreorderResponse(product, quantity, inventory, shipping, pricing, region) {
  const allocationPct = Math.round((inventory.netAvailable / (inventory.allocated || 1)) * 100);

  return {
    product: {
      sku: product.sku,
      name: product.name,
      line: product.line,
      wave: product.wave,
    },
    inventory: {
      available: inventory.netAvailable,
      allocationPct,
      warehouse: inventory.warehouse ? inventory.warehouse.name : 'Unassigned',
    },
    shipping: {
      method: shipping.method,
      estimatedDays: shipping.estimatedDays,
      cost: shipping.cost,
    },
    pricing: {
      unitPrice: pricing.unitPrice,
      quantity,
      subtotal: pricing.subtotal,
      preorderSavings: pricing.preorderSavings,
      edition: pricing.edition,
    },
    region,
  };
}

/**
 * Process a collectibles pre-order request.
 */
async function processPreorder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing pre-order', {
    orderId,
    sku: data.sku,
    quantity: data.quantity,
    region: data.region,
    productLine: data.productLine || 'marvel-legends',
    service: 'customer-f2f54159-preorder',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 80));

    const product = lookupProduct(data.sku);
    if (!product) throw new Error(`Unknown product SKU: ${data.sku}`);

    const inventory = checkInventory(product, data.region);
    const shipping = calculateShipping(data.region, data.shippingPreference);
    const pricing = calculatePricing(product, data.quantity);

    const response = buildPreorderResponse(product, data.quantity, inventory, shipping, pricing, data.region);

    const duration = Date.now() - startTime;

    incrementMetric('preorder.success', {
      route: '/api/f2f54159/preorder',
      productLine: data.productLine || 'marvel-legends',
    });
    recordTiming('preorder.latency', duration, {
      route: '/api/f2f54159/preorder',
    });

    return {
      success: true,
      orderId,
      ...response,
      status: 'pre-order-confirmed',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('preorder.failure', {
      route: '/api/f2f54159/preorder',
      errorClass: error.name,
    });
    recordTiming('preorder.latency', duration, {
      route: '/api/f2f54159/preorder',
      error: 'true',
    });

    logger.error('Pre-order processing failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      sku: data.sku,
      region: data.region,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/f2f54159/preorder',
        service: 'customer-f2f54159-preorder',
        productLine: data.productLine || 'marvel-legends',
      },
      extra: {
        orderId,
        sku: data.sku,
        region: data.region,
        productLine: data.productLine || 'marvel-legends',
        email: data.email,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'devin-gtm'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || '4511033758449664'}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f2f54159.js — processPreorder',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      service: 'customer-f2f54159-preorder',
      verticalLabel: 'Collectibles Pre-Order',
      tags: [
        { key: 'route', value: '/api/f2f54159/preorder' },
        { key: 'service', value: 'customer-f2f54159-preorder' },
        { key: 'productLine', value: data.productLine || 'marvel-legends' },
      ],
      extra: { orderId, sku: data.sku, region: data.region, email: data.email },
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
      logger.error('Failed to trigger Devin session from pre-order error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processPreorder, PRODUCTS, WAREHOUSES, SHIPPING_METHODS, PRICING_RULES };
