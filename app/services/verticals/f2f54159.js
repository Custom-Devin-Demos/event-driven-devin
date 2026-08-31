const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const PRODUCT_LINES = [
  { id: 'marvel-legends', name: 'Marvel Legends', basePrice: 27.99, waveSize: 7, buildAFigure: true },
  { id: 'transformers-gen', name: 'Transformers Generations', basePrice: 24.99, waveSize: 6, buildAFigure: false },
  { id: 'star-wars-black', name: 'Star Wars Black Series', basePrice: 29.99, waveSize: 8, buildAFigure: false },
  { id: 'gi-joe-classified', name: 'G.I. Joe Classified', basePrice: 26.99, waveSize: 5, buildAFigure: false },
  { id: 'ghostbusters-plasma', name: 'Ghostbusters Plasma Series', basePrice: 31.99, waveSize: 4, buildAFigure: true },
  { id: 'power-rangers-lightning', name: 'Power Rangers Lightning', basePrice: 28.99, waveSize: 6, buildAFigure: false },
];

const SHIPPING_REGIONS = {
  'us-contiguous': { label: 'US (Contiguous)', baseCost: 6.99, freeThreshold: 50, deliveryDays: { min: 3, max: 7 } },
  'us-alaska-hawaii': { label: 'US (Alaska/Hawaii)', baseCost: 14.99, freeThreshold: 100, deliveryDays: { min: 7, max: 14 } },
  'canada': { label: 'Canada', baseCost: 12.99, freeThreshold: 75, deliveryDays: { min: 7, max: 14 } },
  'international': { label: 'International', baseCost: 24.99, freeThreshold: null, deliveryDays: { min: 14, max: 28 } },
};

const MEMBERSHIP_TIERS = {
  standard: { discountPct: 0, freeShipping: false, earlyAccess: false, priority: 1 },
  premium: { discountPct: 10, freeShipping: true, earlyAccess: true, priority: 2 },
};

const INVENTORY_POOL = {
  'marvel-legends': { available: 4200, reserved: 380, warehouse: 'us-east-1' },
  'transformers-gen': { available: 3100, reserved: 210, warehouse: 'us-west-2' },
  'star-wars-black': { available: 5800, reserved: 620, warehouse: 'us-east-1' },
  'gi-joe-classified': { available: 1800, reserved: 95, warehouse: 'us-central-1' },
  'ghostbusters-plasma': { available: 950, reserved: 40, warehouse: 'us-east-1' },
  'power-rangers-lightning': { available: 2200, reserved: 175, warehouse: 'us-west-2' },
};

function resolveProductLine(productLineId) {
  const line = PRODUCT_LINES.find((p) => p.id === productLineId);
  if (!line) return PRODUCT_LINES[0];
  return line;
}

function getInventoryStatus(productLineId) {
  const pool = INVENTORY_POOL[productLineId];
  if (!pool) return { available: 0, reserved: 0, warehouse: 'unknown' };
  return {
    onHand: pool.available,
    allocated: pool.reserved,
    netAvailable: pool.available - pool.reserved,
    location: { warehouse: pool.warehouse, zone: 'A' },
  };
}

function computeShipping(region, subtotal, membership) {
  const regionConfig = SHIPPING_REGIONS[region];
  const memberConfig = MEMBERSHIP_TIERS[membership];

  if (memberConfig.freeShipping) {
    return { cost: 0, method: 'Premium Free Shipping', estimatedDays: regionConfig.deliveryDays };
  }

  if (regionConfig.freeThreshold && subtotal >= regionConfig.freeThreshold) {
    return { cost: 0, method: 'Free Shipping (threshold met)', estimatedDays: regionConfig.deliveryDays };
  }

  return { cost: regionConfig.baseCost, method: 'Standard Shipping', estimatedDays: regionConfig.deliveryDays };
}

function calculateOrderTotal(product, quantity, shipping, membership) {
  const memberConfig = MEMBERSHIP_TIERS[membership];
  const unitPrice = product.basePrice;
  const subtotal = unitPrice * quantity;
  const discount = subtotal * (memberConfig.discountPct / 100);
  const shippingCost = shipping.cost;

  return {
    unitPrice,
    subtotal,
    discount: Math.round(discount * 100) / 100,
    shipping: shippingCost,
    total: Math.round((subtotal - discount + shippingCost) * 100) / 100,
  };
}

function estimateShipDate(inventory, quantity, region) {
  const regionConfig = SHIPPING_REGIONS[region];
  const daysToFulfill = inventory.netAvailable >= quantity ? 1 : 14;
  const transitDays = regionConfig.deliveryDays.max;
  const shipDate = new Date();
  shipDate.setDate(shipDate.getDate() + daysToFulfill + transitDays);
  return shipDate.toISOString().split('T')[0];
}

function buildPreorderResponse(product, quantity, inventory, shipping, pricing, region) {
  const fulfillable = inventory.netAvailable >= quantity;
  const allocationPct = Math.round((inventory.allocated / inventory.onHand) * 100);

  return {
    productLine: product.name,
    productId: product.id,
    quantity,
    fulfillable,
    inventory: {
      available: inventory.netAvailable,
      allocationPct,
      warehouse: inventory.warehouse.name,
    },
    shipping: {
      method: shipping.method,
      cost: shipping.cost,
      estimatedDays: shipping.estimatedDays,
    },
    pricing,
    estimatedShipDate: estimateShipDate(inventory, quantity, region),
    waveInfo: {
      waveSize: product.waveSize,
      buildAFigure: product.buildAFigure,
    },
  };
}

async function processPreorder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Processing pre-order request', {
    orderId,
    productLine: data.productLine,
    quantity: data.quantity,
    region: data.region,
    membership: data.membership,
    service: 'customer-f2f54159-preorder',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 100));

    const product = resolveProductLine(data.productLine);
    const inventory = getInventoryStatus(data.productLine);
    const subtotal = product.basePrice * data.quantity;
    const shipping = computeShipping(data.region, subtotal, data.membership);
    const pricing = calculateOrderTotal(product, data.quantity, shipping, data.membership);
    const response = buildPreorderResponse(product, data.quantity, inventory, shipping, pricing, data.region);

    response.orderId = orderId;
    response.completedAt = new Date().toISOString();
    response.customer = {
      name: `${data.firstName} ${data.lastName}`,
      email: data.email,
    };

    if (!response.fulfillable) {
      response.backorderNotice = 'Item is currently on backorder. You will be notified when stock is replenished.';
    }

    const duration = Date.now() - startTime;

    incrementMetric('preorder.success', {
      route: '/api/f2f54159/preorder',
      productLine: data.productLine,
    });
    recordTiming('preorder.latency', duration, {
      route: '/api/f2f54159/preorder',
    });

    return response;
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
      productLine: data.productLine,
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/f2f54159/preorder',
        service: 'customer-f2f54159-preorder',
        productLine: data.productLine,
      },
      extra: { orderId, email: data.email, productLine: data.productLine },
    });

    createSessionAndAlert({
      customer: 'f2f54159',
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/f2f54159.js — processPreorder',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinOrgId: data.devinOrgId,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      service: 'customer-f2f54159-preorder',
      verticalLabel: 'Pre-Order Processing Error',
      tags: [
        { key: 'route', value: '/api/f2f54159/preorder' },
        { key: 'service', value: 'customer-f2f54159-preorder' },
        { key: 'productLine', value: data.productLine },
      ],
      extra: { orderId, email: data.email, productLine: data.productLine },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'customer-f2f54159-preorder@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from preorder error', { error: err.message });
    });

    throw error;
  }
}

module.exports = { processPreorder, PRODUCT_LINES, SHIPPING_REGIONS };
