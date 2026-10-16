const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { PRODUCTS } = require('../verticals/coppel');

const ROUTE = '/api/oncall/clickcollect/checkout';
const SERVICE = 'pedidos-api';

/**
 * Coppel stores offering "Recoger en tienda". Prices are MXN, IVA included.
 */
const STORES = {
  '0071': { name: 'Coppel Culiacán Centro', city: 'Culiacán, Sin.' },
  '1240': { name: 'Coppel Reforma Centro', city: 'Ciudad de México' },
};

/**
 * Stores within pickup radius of each pickup store, nearest first. A pickup
 * order is held at the selected store; the others are fallbacks.
 */
const NEARBY_STORES = {
  '0071': ['0071', '0112', '0348', '0519', '0602', '0877'],
  '1240': ['1240', '1187', '1302', '1415', '1033', '0964'],
};

const DELIVERY = new Set(['domicilio', 'tienda']);
const MAX_CART_LINES = 20;
const STORE_HOLD_DEADLINE_MS = 8000;
const STORE_HOLD_LATENCY_MS = [1400, 1700];
const FREE_SHIPPING_THRESHOLD = 499;
const STANDARD_SHIPPING = 99;

/**
 * Apartar one cart line at a single store. Each call is a round trip to the
 * store inventory service.
 */
function holdAtStore(storeNumber, line) {
  const [minMs, maxMs] = STORE_HOLD_LATENCY_MS;
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ storeNumber, sku: line.sku, held: true, holdRef: `APT-${storeNumber}-${line.sku.slice(-6)}` });
    }, minMs + Math.random() * (maxMs - minMs));
  });
}

function invalidCart(message) {
  const err = new Error(message);
  err.code = 'INVALID_CART';
  return err;
}

function findProduct(sku) {
  return PRODUCTS.find((product) => product.id === sku) || null;
}

/** Validates requested lines and merges duplicate SKUs. */
function buildCartLines(requested) {
  if (!Array.isArray(requested) || !requested.length) throw invalidCart('Tu carrito está vacío. Agrega al menos un producto.');
  if (requested.length > MAX_CART_LINES) throw invalidCart(`El carrito no puede tener más de ${MAX_CART_LINES} productos`);
  const qtyBySku = new Map();
  for (const item of requested) {
    const product = item && findProduct(item.sku);
    if (!product) throw invalidCart(`Producto desconocido: ${item && item.sku}`);
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1) throw invalidCart(`La cantidad de ${product.id} debe ser un entero positivo`);
    qtyBySku.set(product.id, (qtyBySku.get(product.id) || 0) + qty);
  }
  return [...qtyBySku].map(([sku, qty]) => {
    const product = findProduct(sku);
    return {
      sku,
      name: product.name,
      qty,
      unitPrice: product.price,
      listPrice: product.listPrice,
      lineTotal: product.price * qty,
    };
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

/**
 * Apartar every cart line for store pickup so the items are pulled from the
 * floor before the order is confirmed.
 */
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
        endpoint: 'inventario-tiendas/v2/apartado',
      });
      if (store === storeNumber) holds.push(hold);
    }
  }
  return holds;
}

/**
 * Price and place a Coppel cart checkout ("Continuar compra"). Store-pickup
 * orders apartan inventory at the pickup store before confirming.
 */
async function checkoutOrder(data = {}) {
  const startTime = Date.now();
  const orderId = `CPL${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const delivery = DELIVERY.has(data.delivery) ? data.delivery : 'domicilio';
  const storeNumber = Object.hasOwn(STORES, data.storeNumber) ? data.storeNumber : '0071';

  logger.info('Cart checkout started', { orderId, delivery, storeNumber, service: SERVICE, route: ROUTE });

  try {
    const lines = buildCartLines(data.items === undefined ? [{ sku: 'TEL-SAMS-A54', qty: 1 }] : data.items);
    const holds = delivery === 'tienda'
      ? await withDeadline(holdPickupInventory(lines, storeNumber, orderId), STORE_HOLD_DEADLINE_MS, 'Store pickup hold')
      : [];

    const subtotal = lines.reduce((sum, line) => sum + line.listPrice * line.qty, 0);
    const total = lines.reduce((sum, line) => sum + line.lineTotal, 0);
    const shipping = delivery === 'tienda' || total >= FREE_SHIPPING_THRESHOLD ? 0 : STANDARD_SHIPPING;

    incrementMetric('order.checkout.success', { route: ROUTE, delivery });
    recordTiming('order.checkout.latency', Date.now() - startTime, { route: ROUTE, delivery });

    return {
      success: true,
      orderId,
      delivery,
      store: delivery === 'tienda' ? { number: storeNumber, ...STORES[storeNumber] } : null,
      lines,
      holds,
      subtotal,
      discount: subtotal - total,
      shipping,
      total: total + shipping,
      currency: 'MXN',
      placedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('order.checkout.failure', { route: ROUTE, delivery, errorClass: error.name });
    recordTiming('order.checkout.latency', duration, { route: ROUTE, delivery, error: 'true' });
    logger.error('Cart checkout failed', {
      orderId, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, delivery, storeNumber,
    });
    if (error.code !== 'INVALID_CART') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE, delivery },
        extra: { orderId, storeNumber },
      });
    }
    throw error;
  }
}

module.exports = { checkoutOrder, NEARBY_STORES, STORES, STORE_HOLD_DEADLINE_MS };
