const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { CATALOG, PROMOTIONS, SHIPPING_METHODS } = require('../verticals/f813dd7a');

const ROUTE = '/api/oncall/storepickup/checkout';
const SERVICE = 'checkout-api';
const STORES = {
  '0412': { city: 'San Francisco, CA', zipCode: '94108' },
};
const NEARBY_STORES = {
  '0412': ['0412', '0388', '0517', '0291', '0634', '0450', '0573', '0206'],
};

const MAX_CART_LINES = 20;
const MAX_QUANTITY = 10;
const STORE_HOLD_DEADLINE_MS = 8000;
const STORE_HOLD_LATENCY_MS = [1100, 1300];

function invalidCart(message) {
  const err = new Error(message);
  err.code = 'INVALID_CART';
  return err;
}

function normalizeCartItems(requested) {
  if (!Array.isArray(requested) || !requested.length) {
    throw invalidCart('Cart must contain at least one item');
  }
  if (requested.length > MAX_CART_LINES) {
    throw invalidCart(`Cart cannot contain more than ${MAX_CART_LINES} lines`);
  }

  const qtyBySku = new Map();
  for (const item of requested) {
    const product = item && CATALOG.find((entry) => entry.sku === item.sku);
    if (!product || !Number.isFinite(product.price)) {
      throw invalidCart(`Unknown SKU: ${item && item.sku}`);
    }
    if (!Number.isInteger(item.qty) || item.qty < 1 || item.qty > MAX_QUANTITY) {
      throw invalidCart(`Quantity for ${product.sku} must be between 1 and ${MAX_QUANTITY}`);
    }
    const qty = (qtyBySku.get(product.sku) || 0) + item.qty;
    if (qty > MAX_QUANTITY) {
      throw invalidCart(`Quantity for ${product.sku} must be between 1 and ${MAX_QUANTITY}`);
    }
    qtyBySku.set(product.sku, qty);
  }

  return [...qtyBySku].map(([sku, qty]) => {
    const product = CATALOG.find((entry) => entry.sku === sku);
    return {
      sku,
      name: product.name,
      qty,
      price: Math.round(product.price * 100) / 100,
      lineTotal: Math.round(product.price * 100) * qty / 100,
    };
  });
}

function holdAtStore(storeNumber, line) {
  const [minMs, maxMs] = STORE_HOLD_LATENCY_MS;
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({
        storeNumber,
        sku: line.sku,
        held: true,
        holdRef: `HLD-${storeNumber}-${line.sku.slice(-6)}`,
      });
    }, minMs + Math.random() * (maxMs - minMs));
  });
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms`);
      err.code = 'STORE_HOLD_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

async function holdPickupInventory(lines, storeNumber, orderId) {
  const holds = [];
  for (const line of lines) {
    for (const store of NEARBY_STORES[storeNumber] || [storeNumber]) {
      const startedAt = Date.now();
      const hold = await holdAtStore(store, line);
      logger.info('Store inventory hold', {
        orderId,
        sku: line.sku,
        pickupStore: storeNumber,
        holdStore: store,
        durationMs: Date.now() - startedAt,
        service: SERVICE,
        endpoint: 'store-inventory/v2/hold',
      });
      if (store === storeNumber) holds.push(hold);
    }
  }
  return holds;
}

async function checkoutOrder(data = {}) {
  const startTime = Date.now();
  const orderId = `ORD${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const fulfillment = data.fulfillment === 'pickup' ? 'pickup' : 'ship';
  const storeNumber = Object.hasOwn(STORES, data.storeNumber) ? data.storeNumber : '0412';

  logger.info('Cart checkout started', {
    orderId,
    fulfillment,
    storeNumber,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const lines = normalizeCartItems(data.items);
    const subtotalCents = lines.reduce((sum, line) => sum + Math.round(line.price * 100) * line.qty, 0);
    const promotion = data.promoCode && Object.hasOwn(PROMOTIONS, data.promoCode)
      ? PROMOTIONS[data.promoCode]
      : null;
    const savingsCents = promotion
      ? Math.round(subtotalCents * promotion.discountRate)
      : 0;
    const merchandiseCents = subtotalCents - savingsCents;
    const holds = fulfillment === 'pickup'
      ? await withDeadline(
        holdPickupInventory(lines, storeNumber, orderId),
        STORE_HOLD_DEADLINE_MS,
        'Store pickup hold',
      )
      : [];
    const standardShipping = SHIPPING_METHODS.standard;
    const shippingCents = fulfillment === 'pickup'
      ? 0
      : merchandiseCents >= Math.round(standardShipping.freeThreshold * 100)
        ? 0
        : Math.round(standardShipping.baseFee * 100);
    const taxCents = Math.round(merchandiseCents * standardShipping.taxRate);
    const totalCents = merchandiseCents + shippingCents + taxCents;

    incrementMetric('order.checkout.success', { route: ROUTE, fulfillment });
    recordTiming('order.checkout.latency', Date.now() - startTime, { route: ROUTE, fulfillment });

    return {
      success: true,
      orderId,
      confirmationId: uuidv4(),
      fulfillment,
      store: fulfillment === 'pickup' ? { number: storeNumber, ...STORES[storeNumber] } : null,
      lines,
      holds,
      subtotal: subtotalCents / 100,
      savings: savingsCents / 100,
      shipping: shippingCents / 100,
      tax: taxCents / 100,
      total: totalCents / 100,
      placedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('order.checkout.failure', { route: ROUTE, fulfillment, errorClass: error.name });
    recordTiming('order.checkout.latency', duration, { route: ROUTE, fulfillment, error: 'true' });
    logger.error('Cart checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
      fulfillment,
      storeNumber,
    });
    if (error.code !== 'INVALID_CART') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE, fulfillment },
        extra: { orderId, storeNumber },
      });
    }
    throw error;
  }
}

module.exports = { checkoutOrder, NEARBY_STORES, STORE_HOLD_DEADLINE_MS };
