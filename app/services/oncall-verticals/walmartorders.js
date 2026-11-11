const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { tracer, incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const SERVICE = 'walmart-cart-order-api';
const ROUTE = '/api/oncall/walmartorders/orders';
const RELEASE = 'cart-pricing@2026.11.4';

/**
 * Sellable catalog items, as published by the merchandising feed (v3).
 * `promo.offerType` is the feed's offer classification code.
 */
const CATALOG = new Map([
  ['WM-58114027', {
    name: 'Deluxe 4.5 Quart Tilt-Head Stand Mixer with Stainless Bowl, Sage',
    seller: 'Walmart',
    listPrice: 379.00,
    promo: { offerId: 'RB-2611-MIX', offerType: 'RBK.STD', promoPrice: 249.00 },
    maxQuantity: 12,
  }],
]);

const PROTECTION_PLANS = { '3yr': { label: '3-Year Plan', price: 27.00 }, '4yr': { label: '4-Year Plan', price: 39.00 } };

/**
 * Price adjustment policy per promotion type. `maxDiscountPct` caps how far a
 * promotion may reduce the list price before the line is held for review.
 */
const PRICE_ADJUSTMENT_RULES = {
  ROLLBACK: { maxDiscountPct: 40, stackable: false, label: 'Rollback' },
  CLEARANCE: { maxDiscountPct: 75, stackable: false, label: 'Clearance' },
  SPECIAL_BUY: { maxDiscountPct: 30, stackable: true, label: 'Special Buy' },
};

function rejectOrder(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ORDER' });
}

function validateOrder(order = {}) {
  const lines = Array.isArray(order.items) ? order.items : [];
  if (lines.length === 0 || lines.length > 20) throw rejectOrder('Your cart is empty.');
  const items = lines.map((line) => {
    const itemId = line && typeof line.itemId === 'string' ? line.itemId : '';
    const item = CATALOG.get(itemId);
    const quantity = Number(line && line.quantity);
    if (!item) throw rejectOrder('One of the items in your cart is no longer available.');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > item.maxQuantity) {
      throw rejectOrder(`Quantity must be between 1 and ${item.maxQuantity}.`);
    }
    const planKey = line.protectionPlan == null || line.protectionPlan === '' ? null : String(line.protectionPlan);
    if (planKey && !Object.prototype.hasOwnProperty.call(PROTECTION_PLANS, planKey)) throw rejectOrder('Choose a valid protection plan.');
    return { itemId, item, quantity, protectionPlan: planKey ? PROTECTION_PLANS[planKey] : null };
  });
  const fulfillment = order.fulfillment === 'pickup' ? 'pickup' : order.fulfillment === 'shipping' ? 'shipping' : null;
  if (!fulfillment) throw rejectOrder('Choose shipping or pickup.');
  const zip = typeof order.zip === 'string' ? order.zip.trim() : '';
  if (!/^\d{5}$/.test(zip)) throw rejectOrder('Enter a valid 5-digit ZIP code.');
  return { items, fulfillment, zip, gift: order.gift === true };
}

function promotionKeyFor(line) {
  return line.item.promo.offerType;
}

function applyPriceAdjustments(line) {
  const { listPrice, promo } = line.item;
  const rule = PRICE_ADJUSTMENT_RULES[promotionKeyFor(line)];
  const maxDiscount = (listPrice * rule.maxDiscountPct) / 100;
  const discount = Math.min(listPrice - promo.promoPrice, maxDiscount);
  const unitPrice = Number((listPrice - discount).toFixed(2));
  return { offerId: promo.offerId, label: rule.label, unitPrice, savings: Number((discount * line.quantity).toFixed(2)) };
}

function priceCart(order) {
  const lines = order.items.map((line) => {
    const adjustment = applyPriceAdjustments(line);
    const planTotal = line.protectionPlan ? line.protectionPlan.price : 0;
    return {
      itemId: line.itemId,
      name: line.item.name,
      quantity: line.quantity,
      unitPrice: adjustment.unitPrice,
      promotion: adjustment.label,
      savings: adjustment.savings,
      protectionPlan: line.protectionPlan ? line.protectionPlan.label : null,
      lineTotal: Number((adjustment.unitPrice * line.quantity + planTotal).toFixed(2)),
    };
  });
  const subtotal = Number(lines.reduce((sum, line) => sum + line.lineTotal, 0).toFixed(2));
  const savings = Number(lines.reduce((sum, line) => sum + line.savings, 0).toFixed(2));
  return { lines, subtotal, savings, shipping: 0 };
}

/**
 * Price the cart and place the order.
 */
async function placeOrder(data) {
  const order = validateOrder(data);
  const orderId = uuidv4();
  const started = Date.now();
  const tags = { service: SERVICE, route: ROUTE, release: RELEASE };
  return tracer.trace('walmart.cart.place_order', { service: SERVICE, resource: `POST ${ROUTE}`, tags }, async () => {
    try {
      const priced = priceCart(order);
      const durationMs = Date.now() - started;
      incrementMetric('walmart.cart.order.success', tags);
      recordTiming('walmart.cart.order.latency', durationMs, tags);
      logger.info('Cart order placed', { ...tags, orderId, lines: priced.lines.length, fulfillment: order.fulfillment });
      return {
        success: true,
        orderId,
        orderNumber: `2000${orderId.replace(/\D/g, '').slice(0, 9).padEnd(9, '0')}`,
        status: 'PLACED',
        fulfillment: order.fulfillment,
        zip: order.zip,
        ...priced,
        estimatedTotal: priced.subtotal,
        placedAt: new Date().toISOString(),
      };
    } catch (error) {
      incrementMetric('walmart.cart.order.failure', { ...tags, errorClass: error.name });
      recordTiming('walmart.cart.order.latency', Date.now() - started, { ...tags, error: 'true' });
      logger.error('Cart order pricing failed', {
        ...tags, orderId, itemIds: order.items.map((line) => line.itemId),
        error: error.message, errorClass: error.name, stack: error.stack,
      });
      Sentry.captureException(error, { tags, extra: { orderId, itemIds: order.items.map((line) => line.itemId) } });
      throw error;
    }
  });
}

module.exports = { CATALOG, PRICE_ADJUSTMENT_RULES, placeOrder };
