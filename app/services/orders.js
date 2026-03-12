const logger = require('../telemetry/logger');
const { incrementMetric, recordTiming } = require('../telemetry/datadog');
const { getScenario } = require('../incidentModes');

// In-memory order store (would be a DB in production)
const orderStore = new Map();

// Seed some demo orders
const seedOrders = [
  {
    orderId: 'ord_demo_001',
    userId: 'usr_b1_acme',
    items: [{ sku: 'WIDGET-001', qty: 2, price: 29.99 }],
    subtotal: 59.98,
    tax: 4.80,
    total: 64.78,
    status: 'delivered',
    region: 'US',
    createdAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    orderId: 'ord_demo_002',
    userId: 'usr_b2_acme',
    items: [{ sku: 'GADGET-001', qty: 1, price: 49.99 }],
    subtotal: 49.99,
    tax: 4.00,
    total: 53.99,
    status: 'shipped',
    region: 'US',
    createdAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
  },
  {
    orderId: 'ord_demo_003',
    userId: 'usr_admin_acme',
    items: [{ sku: 'TOOL-001', qty: 1, price: 89.99 }],
    subtotal: 89.99,
    tax: 7.20,
    total: 97.19,
    status: 'processing',
    region: 'US',
    createdAt: new Date(Date.now() - 1 * 24 * 60 * 60 * 1000).toISOString(),
  },
];

// Initialize seed data
seedOrders.forEach((order) => orderStore.set(order.orderId, order));

function addOrder(order) {
  orderStore.set(order.orderId, order);
}

async function getOrder(orderId, persona) {
  const startTime = Date.now();
  const scenario = getScenario();

  logger.info('Order lookup', {
    orderId,
    persona,
    scenario,
    route: '/orders',
  });

  await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60));

  const order = orderStore.get(orderId);
  const duration = Date.now() - startTime;

  incrementMetric('orders.lookup', {
    route: '/orders',
    persona: persona || 'unknown',
    found: order ? 'true' : 'false',
  });
  recordTiming('orders.latency', duration, {
    route: '/orders',
    persona: persona || 'unknown',
  });

  if (!order) {
    logger.warn('Order not found', { orderId, durationMs: duration });
    return null;
  }

  logger.info('Order found', {
    orderId,
    status: order.status,
    durationMs: duration,
  });

  return order;
}

async function listOrders(userId) {
  const orders = [];
  for (const order of orderStore.values()) {
    if (!userId || order.userId === userId) {
      orders.push(order);
    }
  }
  return orders;
}

module.exports = { getOrder, listOrders, addOrder };
