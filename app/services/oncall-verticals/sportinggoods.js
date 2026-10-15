const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const {
  findProduct, findMember, buildCartLines, computeShipping, computeTax, roundCurrency,
  resolveScoreCardTier, computeScoreCardEarn, STORES, SHIPPING, PAYMENT_METHODS,
} = require('../verticals/1b17e823');

const ROUTE = '/api/oncall/sportinggoods/checkout';
const SERVICE = 'order-api';

/**
 * Stores within pickup radius of each pickup store, nearest first. A pickup
 * order is held at the selected store; the others are fallbacks.
 */
const NEARBY_STORES = {
  '0212': ['0212', '0418', '0733', '1102', '0991', '0156'],
  '1487': ['1487', '1520', '0884', '1311', '0677', '1049'],
};

const STORE_HOLD_DEADLINE_MS = 8000;
const STORE_HOLD_LATENCY_MS = [700, 900];

/**
 * Place a hold for one cart line at a single store. Each call is a round trip
 * to the store inventory service.
 */
function holdAtStore(storeNumber, line) {
  const [minMs, maxMs] = STORE_HOLD_LATENCY_MS;
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ storeNumber, sku: line.sku, held: true, holdRef: `HLD-${storeNumber}-${line.sku.slice(-6)}` });
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

/**
 * Hold every cart line for store pickup so the items are pulled from the
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
        endpoint: 'store-inventory/v2/hold',
      });
      if (store === storeNumber) holds.push(hold);
    }
  }
  return holds;
}

/**
 * Price and place a cart checkout. Store-pickup orders hold inventory at the
 * pickup store before confirming.
 */
async function checkoutOrder(data) {
  const startTime = Date.now();
  const orderId = `DSG${uuidv4().replace(/-/g, '').slice(0, 12).toUpperCase()}`;
  const fulfillment = Object.hasOwn(SHIPPING, data.fulfillment) ? data.fulfillment : 'ship';
  const storeNumber = Object.hasOwn(STORES, data.storeNumber) ? data.storeNumber : '0212';
  const member = findMember(data.memberId);

  logger.info('Cart checkout started', { orderId, fulfillment, storeNumber, service: SERVICE, route: ROUTE });

  try {
    const items = Array.isArray(data.items) && data.items.length
      ? data.items
      : [{ sku: '24NIKMPGSS41RDXXXRNN', qty: 1 }, { sku: '20SPAUTF1000LGCYBSKB', qty: 1 }];
    for (const item of items) {
      if (!findProduct(item && item.sku)) {
        const err = new Error(`Unknown SKU: ${item && item.sku}`);
        err.code = 'INVALID_CART';
        throw err;
      }
    }

    const lines = buildCartLines(items);
    const holds = fulfillment === 'pickup'
      ? await withDeadline(holdPickupInventory(lines, storeNumber, orderId), STORE_HOLD_DEADLINE_MS, 'Store pickup hold')
      : [];

    const subtotal = roundCurrency(lines.reduce((sum, line) => sum + line.lineTotal, 0));
    const shipping = computeShipping(fulfillment, subtotal);
    const zipCode = fulfillment === 'pickup' ? STORES[storeNumber].zipCode : (data.zipCode || STORES[storeNumber].zipCode);
    const tax = computeTax(lines, zipCode);
    const tierKey = resolveScoreCardTier(member);
    const scorecard = computeScoreCardEarn(member, tierKey, subtotal);
    const total = roundCurrency(subtotal + shipping.fee + tax.tax);
    const paymentMethod = Object.hasOwn(PAYMENT_METHODS, data.paymentMethod) ? data.paymentMethod : 'card';

    incrementMetric('order.checkout.success', { route: ROUTE, fulfillment });
    recordTiming('order.checkout.latency', Date.now() - startTime, { route: ROUTE, fulfillment });

    return {
      success: true,
      orderId,
      confirmationId: uuidv4(),
      store: { number: storeNumber, ...STORES[storeNumber] },
      lines,
      holds,
      subtotal,
      shipping,
      tax,
      total,
      payment: { method: paymentMethod, label: PAYMENT_METHODS[paymentMethod] },
      scorecard,
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

module.exports = { checkoutOrder, NEARBY_STORES, STORE_HOLD_DEADLINE_MS };
