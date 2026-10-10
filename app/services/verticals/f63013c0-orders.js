const crypto = require('crypto');

/**
 * In-memory order store for checkout-service.
 *
 * A pending order is keyed to its basket (`cartId`): a customer retry
 * reuses the same pending order — and therefore the same PSP reference —
 * instead of minting a new order id each attempt.
 */

const orders = new Map();

function newOrderId() {
  return `ord_${crypto.randomBytes(3).toString('hex').slice(0, 5)}`;
}

function createPending({ customerId, cartId, lines, total, shipTo, addressId, paymentMethod }) {
  const existing = [...orders.values()]
    .find((o) => o.cartId === cartId && o.status === 'pending');
  if (existing) return existing;

  const order = {
    id: newOrderId(),
    status: 'pending',
    customerId,
    cartId,
    lines,
    total,
    shipTo: shipTo || null,
    addressId: addressId || null,
    paymentMethod: paymentMethod || 'card',
    paymentId: null,
    createdAt: new Date().toISOString(),
    completedAt: null,
  };
  orders.set(order.id, order);
  return order;
}

function complete(id, paymentId) {
  const order = orders.get(id);
  if (!order) return null;
  order.status = 'paid';
  order.paymentId = paymentId;
  order.completedAt = new Date().toISOString();
  return order;
}

function get(id) {
  return orders.get(id) || null;
}

function list({ status } = {}) {
  const all = [...orders.values()];
  return status ? all.filter((o) => o.status === status) : all;
}

function reset() {
  orders.clear();
}

module.exports = {
  createPending,
  complete,
  get,
  list,
  reset,
};
