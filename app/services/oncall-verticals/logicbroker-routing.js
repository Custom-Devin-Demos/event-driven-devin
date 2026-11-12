const { tracer, incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const logger = require('../../telemetry/logger');

const ORDERS = [
  { id: 'PO28371271-001', retailer: 'Harborline Home', quantity: 200, product: 'Tri-Ply Copper Sauté Pan 11"' },
  { id: 'PO28371272-001', retailer: 'Crestview Outfitters', quantity: 200, product: 'Tri-Ply Copper Sauté Pan 11"' },
  { id: 'PO28371273-001', retailer: 'Willow & Hearth', quantity: 200, product: 'Tri-Ply Copper Sauté Pan 11"' },
];
const SUPPLIERS = [
  { supplier: 'NorthBridge Home Goods', quantity: 100, score: 98, node: 'Columbus OH', shipMethod: 'GROUND' },
  { supplier: 'Apex Tools & Industrial', quantity: 10, score: 94, node: 'Reno NV', shipMethod: 'GROUND' },
  { supplier: 'Summit Electronics Co.', quantity: 15, score: 91, node: 'Austin TX', shipMethod: 'EXPRESS' },
  { supplier: 'Everline Appliances', quantity: 30, score: 89, node: 'Newark NJ', shipMethod: 'GROUND' },
  { supplier: 'Larkspur Cookware Direct', quantity: 45, score: 87, node: 'Savannah GA', shipMethod: 'GROUND_3PL' },
];
const SLA_CUTOFF_RULES = { GROUND: { cutoffHour: 18 }, EXPRESS: { cutoffHour: 20 } };

function orderFor(data = {}) {
  const order = ORDERS.find((item) => item.id === data.orderId);
  if (!order) throw Object.assign(new Error('Choose a pending retailer purchase order.'), { code: 'INVALID_ROUTING' });
  return order;
}

function evaluateRouting(data) {
  const order = orderFor(data);
  return { success: true, order, allocations: SUPPLIERS.map((supplier) => ({ ...supplier, slaCutoff: '18:00 ET', status: 'Ready' })) };
}

function cutoffPolicyFor(allocation) {
  return SLA_CUTOFF_RULES[allocation.shipMethod];
}

function allocateSupplierPOs(plan) {
  if (plan.allocations.reduce((sum, item) => sum + item.quantity, 0) !== plan.order.quantity) {
    throw new Error('Supplier allocations must equal the order quantity.');
  }
  const rules = plan.allocations.map((allocation) => cutoffPolicyFor(allocation));
  const cutoffs = rules.map((rule) => rule.cutoffHour);
  return plan.allocations.map((allocation, index) => {
    if (new Date().getUTCHours() >= cutoffs[index]) throw new Error('The supplier SLA cut-off has passed.');
    return { ...allocation, status: 'Released' };
  });
}

async function releaseSupplierPOs(data) {
  const plan = evaluateRouting(data);
  const started = Date.now();
  const tags = { service: 'lb-order-routing-api', release: 'order-routing@2026.11.3' };
  return tracer.trace('logicbroker.routing.release', { service: tags.service, tags }, async () => {
    try {
      return { success: true, allocations: allocateSupplierPOs(plan) };
    } catch (error) {
      incrementMetric('logicbroker.routing.failure', tags);
      recordTiming('logicbroker.routing.latency', Date.now() - started, tags);
      logger.error('Supplier PO release failed', { ...tags, error: error.message, stack: error.stack });
      Sentry.captureException(error, { tags });
      throw error;
    }
  });
}

module.exports = { ORDERS, evaluateRouting, releaseSupplierPOs };
