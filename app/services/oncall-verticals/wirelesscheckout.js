const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { CATALOG } = require('../verticals/4e150e99');

const ROUTE = '/api/oncall/wirelesscheckout/checkout';
const SERVICE = 'order-api';

const STATES = {
  NY: { taxRate: 0.08875, region: 'NE' },
  NJ: { taxRate: 0.06625, region: 'NE' },
  CA: { taxRate: 0.0725, region: 'WEST' },
  TX: { taxRate: 0.0625, region: 'SOUTH' },
  FL: { taxRate: 0.06, region: 'SE' },
  IL: { taxRate: 0.0625, region: 'CENTRAL' },
};

// Regional 5G core subscriber registers (HSS/UDM). A new line only needs
// to be provisioned on the customer's home-region register.
const PROVISIONING_REGIONS = ['NE', 'MIDATL', 'SE', 'SOUTH', 'CENTRAL', 'MOUNTAIN', 'WEST', 'NW'];

const MAX_CART_LINES = 10;
const MAX_QUANTITY = 5;
const ACTIVATION_DEADLINE_MS = 8000;
const REGISTER_LATENCY_MS = [1100, 1300];

function invalidOrder(message) {
  const err = new Error(message);
  err.code = 'INVALID_ORDER';
  return err;
}

function normalizeOrderItems(requested) {
  if (!Array.isArray(requested) || !requested.length) {
    throw invalidOrder('Order must contain at least one item');
  }
  if (requested.length > MAX_CART_LINES) {
    throw invalidOrder(`Order cannot contain more than ${MAX_CART_LINES} lines`);
  }
  const qtyBySku = new Map();
  for (const item of requested) {
    const product = item && CATALOG.find((entry) => entry.id === item.sku);
    if (!product) throw invalidOrder(`Unknown SKU: ${item && item.sku}`);
    if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > MAX_QUANTITY) {
      throw invalidOrder(`Quantity for ${product.id} must be between 1 and ${MAX_QUANTITY}`);
    }
    const qty = (qtyBySku.get(product.id) || 0) + item.qty;
    if (qty > MAX_QUANTITY) {
      throw invalidOrder(`Quantity for ${product.id} must be between 1 and ${MAX_QUANTITY}`);
    }
    qtyBySku.set(product.id, qty);
  }
  return [...qtyBySku].map(([sku, qty]) => {
    const product = CATALOG.find((entry) => entry.id === sku);
    const priceCents = Math.round(product.price * 100);
    return {
      sku,
      name: product.name,
      category: product.category,
      term: product.term,
      qty,
      price: priceCents / 100,
      lineTotal: (priceCents * qty) / 100,
    };
  });
}

function provisionOnRegister(region, line) {
  const [minMs, maxMs] = REGISTER_LATENCY_MS;
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ region, lineId: line.lineId, provisioned: true });
    }, minMs + Math.random() * (maxMs - minMs));
  });
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms`);
      err.code = 'ACTIVATION_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function activateLine(line, homeRegion, orderId) {
  let homeRecord = null;
  for (const region of PROVISIONING_REGIONS) {
    const startedAt = Date.now();
    const record = await provisionOnRegister(region, line);
    logger.info('Subscriber register provisioned', {
      orderId,
      lineId: line.lineId,
      homeRegion,
      region,
      durationMs: Date.now() - startedAt,
      service: SERVICE,
      endpoint: 'network-provisioning/v3/subscriber',
    });
    if (region === homeRegion) homeRecord = record;
  }
  return homeRecord;
}

async function checkoutOrder(data = {}) {
  const startTime = Date.now();
  const orderId = `VZW${uuidv4().replace(/-/g, '').slice(0, 10).toUpperCase()}`;
  const state = data.state;

  logger.info('Wireless checkout started', { orderId, state, service: SERVICE, route: ROUTE });

  try {
    if (!Object.hasOwn(STATES, state)) throw invalidOrder(`Unknown state: ${state}`);
    const lines = normalizeOrderItems(data.items);
    const subtotalCents = lines.reduce((sum, line) => sum + Math.round(line.price * 100) * line.qty, 0);
    const taxCents = Math.round(subtotalCents * STATES[state].taxRate);
    const newLines = lines.filter((line) => line.category === 'plan')
      .flatMap((line) => Array.from({ length: line.qty }, (_, i) => ({ lineId: `${line.sku}-${i + 1}` })));

    const activations = await withDeadline(
      (async () => {
        const records = [];
        for (const line of newLines) {
          records.push(await activateLine(line, STATES[state].region, orderId));
        }
        return records;
      })(),
      ACTIVATION_DEADLINE_MS,
      'Line activation',
    );

    incrementMetric('order.checkout.success', { route: ROUTE });
    recordTiming('order.checkout.latency', Date.now() - startTime, { route: ROUTE });

    return {
      success: true,
      orderId,
      status: 'confirmed',
      receipt: lines,
      activations,
      subtotal: subtotalCents / 100,
      tax: taxCents / 100,
      taxLabel: 'Sales tax',
      total: (subtotalCents + taxCents) / 100,
      currency: 'USD',
      processedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('order.checkout.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('order.checkout.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Wireless checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
      state,
    });
    if (error.code !== 'INVALID_ORDER') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE },
        extra: { orderId, state },
      });
    }
    throw error;
  }
}

module.exports = { checkoutOrder, PROVISIONING_REGIONS, ACTIVATION_DEADLINE_MS };
