const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/homeimprovement/checkout';
const SERVICE = 'cart-checkout-api';

const CATALOG = [
  { sku: '1001726437', brand: 'Milwaukee', name: 'SHOCKWAVE Impact Duty Alloy Steel Drill and Driver Bit Set (100-Piece)', price: 49.97, limitPerOrder: 10 },
  { sku: '1001562840', brand: 'DEWALT', name: '20V MAX Lithium-Ion 2.0Ah Battery Pack (2-Pack)', price: 99.0, limitPerOrder: 5 },
  { sku: '1005409281', brand: 'Husky', name: '17 Gal. Professional Duty Waterproof Storage Container with Hinged Lid in Black', price: 24.98, limitPerOrder: 10 },
];

const STORES = {
  '6177': { name: 'Manhattan 23rd St', city: 'New York, NY', zipCode: '10010', taxRate: 0.08875 },
};

/**
 * Stores within pickup radius of each pickup store, nearest first. The
 * storefront shows them under "Check Nearby Stores" when the pickup store is
 * out of stock.
 */
const NEARBY_STORES = {
  '6177': ['6177', '6175', '6176', '6180', '6874', '6827'],
};

const MAX_CART_LINES = 25;
const RESERVATION_DEADLINE_MS = 8000;
const RESERVATION_LATENCY_MS = [450, 550];
const DELIVERY_FREE_THRESHOLD = 45;
const DELIVERY_FEE = 8.99;

function invalidCart(message) {
  const err = new Error(message);
  err.code = 'INVALID_CART';
  return err;
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function normalizeCartItems(requested) {
  if (!Array.isArray(requested) || !requested.length) throw invalidCart('Cart must contain at least one item');
  if (requested.length > MAX_CART_LINES) throw invalidCart(`Cart cannot contain more than ${MAX_CART_LINES} lines`);
  const qtyBySku = new Map();
  for (const item of requested) {
    const product = item && CATALOG.find((entry) => entry.sku === item.sku);
    if (!product) throw invalidCart(`Unknown SKU: ${item && item.sku}`);
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1) throw invalidCart(`Quantity for ${product.sku} must be a positive integer`);
    qtyBySku.set(product.sku, (qtyBySku.get(product.sku) || 0) + qty);
  }
  return [...qtyBySku].map(([sku, qty]) => {
    const product = CATALOG.find((entry) => entry.sku === sku);
    if (qty > product.limitPerOrder) throw invalidCart(`Quantity for ${sku} must be between 1 and ${product.limitPerOrder}`);
    return { sku, brand: product.brand, name: product.name, qty, price: product.price, lineTotal: roundCurrency(product.price * qty) };
  });
}

/**
 * Reserve one cart line at a single store. Each call is a round trip to the
 * store inventory service.
 */
function reserveAtStore(storeNumber, line) {
  const [minMs, maxMs] = RESERVATION_LATENCY_MS;
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ storeNumber, sku: line.sku, qty: line.qty, reserved: true, reservationId: `RSV-${storeNumber}-${line.sku.slice(-6)}` });
    }, minMs + Math.random() * (maxMs - minMs));
  });
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms`);
      err.code = 'PICKUP_RESERVATION_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Reserve every cart line for in-store pickup so associates can pull the
 * items before the order is released to the store.
 */
async function reservePickupInventory(lines, storeNumber, orderId) {
  const reservations = [];
  for (const line of lines) {
    for (const store of NEARBY_STORES[storeNumber] || [storeNumber]) {
      const startedAt = Date.now();
      const reservation = await reserveAtStore(store, line);
      logger.info('Store inventory reservation', {
        orderId,
        sku: line.sku,
        pickupStore: storeNumber,
        reservationStore: store,
        durationMs: Date.now() - startedAt,
        service: SERVICE,
        endpoint: 'store-inventory/v3/reserve',
      });
      if (store === storeNumber) reservations.push(reservation);
    }
  }
  return reservations;
}

/**
 * Price and place a cart checkout. Pickup orders reserve inventory at the
 * pickup store before the order is confirmed.
 */
async function checkoutOrder(data = {}) {
  const startTime = Date.now();
  const orderId = `W${String(Math.floor(Math.random() * 1e9)).padStart(9, '0')}`;
  const fulfillment = data.fulfillment === 'pickup' ? 'pickup' : 'delivery';
  const storeNumber = Object.hasOwn(STORES, data.storeNumber) ? data.storeNumber : '6177';
  const store = STORES[storeNumber];

  logger.info('Cart checkout started', { orderId, fulfillment, storeNumber, service: SERVICE, route: ROUTE });

  try {
    const lines = normalizeCartItems(data.items);
    const reservations = fulfillment === 'pickup'
      ? await withDeadline(reservePickupInventory(lines, storeNumber, orderId), RESERVATION_DEADLINE_MS, 'Pickup inventory reservation')
      : [];
    const subtotal = roundCurrency(lines.reduce((sum, line) => sum + line.lineTotal, 0));
    const delivery = fulfillment === 'pickup' || subtotal >= DELIVERY_FREE_THRESHOLD ? 0 : DELIVERY_FEE;
    const tax = roundCurrency(subtotal * store.taxRate);
    const total = roundCurrency(subtotal + delivery + tax);

    incrementMetric('order.checkout.success', { route: ROUTE, fulfillment });
    recordTiming('order.checkout.latency', Date.now() - startTime, { route: ROUTE, fulfillment });

    return {
      success: true,
      orderId,
      confirmationId: uuidv4(),
      fulfillment,
      store: { number: storeNumber, name: store.name, city: store.city },
      lines,
      reservations,
      subtotal,
      delivery,
      tax,
      total,
      placedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('order.checkout.failure', { route: ROUTE, fulfillment, errorClass: error.name });
    recordTiming('order.checkout.latency', duration, { route: ROUTE, fulfillment, error: 'true' });
    logger.error('Cart checkout failed', {
      orderId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, fulfillment, storeNumber,
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

module.exports = { checkoutOrder, CATALOG, NEARBY_STORES, RESERVATION_DEADLINE_MS };
