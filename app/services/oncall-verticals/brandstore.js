const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/brandstore/checkout';
const SERVICE = 'basket-checkout-api';

const CATALOG = [
  { sku: '13921461', name: 'Squeezy Sauce Selection Bundle', size: '5 x 400ml', price: 12.0, limitPerOrder: 6 },
  { sku: '14532880', name: 'Personalised Tomato Ketchup Gift Box', size: '460g', price: 15.0, limitPerOrder: 4 },
  { sku: '14118237', name: 'Beanz, Hoops & Soup Family Bundle', size: '16 tins', price: 9.99, limitPerOrder: 6 },
];

/**
 * Loyalty members, with the order history the loyalty ledger holds for each.
 * `cachedBalancePence` is the balance the ledger keeps current on every order.
 */
const MEMBERS = {
  'PZ-5710442': {
    name: 'Sarah',
    cachedBalancePence: 500,
    orderIds: [
      'HTH10482211', 'HTH10511930', 'HTH10560147', 'HTH10603388', 'HTH10641205',
      'HTH10688710', 'HTH10720416', 'HTH10765593', 'HTH10801472', 'HTH10846129',
      'HTH10890035', 'HTH10931764', 'HTH10978820', 'HTH11012451',
    ],
  },
};

const DEFAULT_MEMBER = 'PZ-5710442';
const MAX_BASKET_LINES = 20;
const REDEMPTION_DEADLINE_MS = 8000;
const LEDGER_LATENCY_MS = [560, 640];
const DELIVERY_FREE_THRESHOLD = 25;
const DELIVERY_FEE = 3.5;

function invalidBasket(message) {
  const err = new Error(message);
  err.code = 'INVALID_BASKET';
  return err;
}

function roundCurrency(value) {
  return Math.round(value * 100) / 100;
}

function normalizeBasketItems(requested) {
  if (!Array.isArray(requested) || !requested.length) throw invalidBasket('Basket must contain at least one item');
  if (requested.length > MAX_BASKET_LINES) throw invalidBasket(`Basket cannot contain more than ${MAX_BASKET_LINES} lines`);
  const qtyBySku = new Map();
  for (const item of requested) {
    const product = item && CATALOG.find((entry) => entry.sku === item.sku);
    if (!product) throw invalidBasket(`Unknown SKU: ${item && item.sku}`);
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1) throw invalidBasket(`Quantity for ${product.sku} must be a positive integer`);
    qtyBySku.set(product.sku, (qtyBySku.get(product.sku) || 0) + qty);
  }
  return [...qtyBySku].map(([sku, qty]) => {
    const product = CATALOG.find((entry) => entry.sku === sku);
    if (qty > product.limitPerOrder) throw invalidBasket(`Quantity for ${sku} must be between 1 and ${product.limitPerOrder}`);
    return { sku, name: product.name, qty, price: product.price, lineTotal: roundCurrency(product.price * qty) };
  });
}

/**
 * Fetch the points earned on one past order. Each call is a round trip to the
 * loyalty ledger service.
 */
function fetchOrderEarnings(memberId, orderId) {
  const [minMs, maxMs] = LEDGER_LATENCY_MS;
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ memberId, orderId, earnedPence: 0 });
    }, minMs + Math.random() * (maxMs - minMs));
  });
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms`);
      err.code = 'POINTZ_REDEMPTION_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Confirm the member's redeemable balance before applying it to the order,
 * so a balance spent on another device can't be redeemed twice.
 */
async function resolveRedeemableBalance(memberId, orderRef) {
  const member = MEMBERS[memberId];
  for (const orderId of member.orderIds) {
    const startedAt = Date.now();
    await fetchOrderEarnings(memberId, orderId);
    logger.info('Loyalty ledger lookup', {
      orderRef,
      memberId,
      ledgerOrderId: orderId,
      durationMs: Date.now() - startedAt,
      service: SERVICE,
      endpoint: 'loyalty-ledger/v2/orders/earnings',
    });
  }
  return member.cachedBalancePence;
}

/**
 * Price and place a basket checkout. Loyalty members can redeem their points
 * balance against the order.
 */
async function checkoutBasket(data = {}) {
  const startTime = Date.now();
  const orderRef = `HTH${String(Math.floor(Math.random() * 1e8)).padStart(8, '0')}`;
  const redeemPointz = data.redeemPointz === true;
  const memberId = Object.hasOwn(MEMBERS, data.memberId) ? data.memberId : DEFAULT_MEMBER;

  logger.info('Basket checkout started', { orderRef, redeemPointz, memberId, service: SERVICE, route: ROUTE });

  try {
    const lines = normalizeBasketItems(data.items);
    const subtotal = roundCurrency(lines.reduce((sum, line) => sum + line.lineTotal, 0));
    const balancePence = redeemPointz
      ? await withDeadline(resolveRedeemableBalance(memberId, orderRef), REDEMPTION_DEADLINE_MS, 'Pointz redemption')
      : 0;
    const pointzDiscount = roundCurrency(Math.min(balancePence / 100, subtotal));
    const delivery = subtotal >= DELIVERY_FREE_THRESHOLD ? 0 : DELIVERY_FEE;
    const total = roundCurrency(subtotal - pointzDiscount + delivery);
    const pointzEarned = Math.floor(total / 10) * 100;

    incrementMetric('order.checkout.success', { route: ROUTE, redeemPointz: String(redeemPointz) });
    recordTiming('order.checkout.latency', Date.now() - startTime, { route: ROUTE, redeemPointz: String(redeemPointz) });

    return {
      success: true,
      orderId: orderRef,
      confirmationId: uuidv4(),
      redeemPointz,
      memberId,
      lines,
      subtotal,
      pointzDiscount,
      delivery,
      total,
      pointzEarned,
      placedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('order.checkout.failure', { route: ROUTE, redeemPointz: String(redeemPointz), errorClass: error.name });
    recordTiming('order.checkout.latency', duration, { route: ROUTE, redeemPointz: String(redeemPointz), error: 'true' });
    logger.error('Basket checkout failed', {
      orderRef, error: error.message, errorClass: error.name, code: error.code, durationMs: duration, redeemPointz, memberId,
    });
    if (error.code !== 'INVALID_BASKET') {
      Sentry.captureException(error, {
        tags: { route: ROUTE, service: SERVICE, redeemPointz: String(redeemPointz) },
        extra: { orderRef, memberId },
      });
    }
    throw error;
  }
}

module.exports = { checkoutBasket, CATALOG, MEMBERS, REDEMPTION_DEADLINE_MS };
