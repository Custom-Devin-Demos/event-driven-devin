// Sourcing master data for the Nordstrom.com bag: where each style ships from
// and how long the node needs before the carrier picks it up.

const FULFILLMENT_NODES = {
  'FC-0599': { id: 'FC-0599', name: 'Elizabeth, NJ Fulfillment Center', region: 'east', zone: 5, handlingDays: 1 },
  'FC-0891': { id: 'FC-0891', name: 'Portland, OR Fulfillment Center', region: 'west', zone: 2, handlingDays: 1 },
  'FC-0399': { id: 'FC-0399', name: 'Cedar Rapids, IA Fulfillment Center', region: 'central', zone: 4, handlingDays: 1 },
  'ST-0427': { id: 'ST-0427', name: 'San Francisco Centre (Store 427)', region: 'west', zone: 1, handlingDays: 0 },
};

const VENDORS = {
  'V-BOMBAS': { id: 'V-BOMBAS', name: 'Bombas', warehouse: 'Groveport, OH', region: 'central', zone: 4 },
};

const SOURCING = {
  '8104772': { method: 'NODE', nodeId: 'FC-0891' },
  '7966031': { method: 'NODE', nodeId: 'FC-0599' },
  '8230557': { method: 'VENDOR_DIRECT', vendorId: 'V-BOMBAS', leadDays: 3 },
  '7753218': { method: 'NODE', nodeId: 'ST-0427' },
  '8011945': { method: 'NODE', nodeId: 'FC-0891' },
  '7899410': { method: 'NODE', nodeId: 'FC-0399' },
  '8154093': { method: 'NODE', nodeId: 'FC-0599' },
  '7988126': { method: 'NODE', nodeId: 'FC-0891' },
  '8067734': { method: 'NODE', nodeId: 'FC-0399' },
  '8192205': { method: 'NODE', nodeId: 'FC-0599' },
  '7921583': { method: 'NODE', nodeId: 'ST-0427' },
  '8140667': { method: 'NODE', nodeId: 'FC-0891' },
};

function resolveSourcing(sku) {
  const rule = SOURCING[sku] || { method: 'NODE', nodeId: 'FC-0399' };
  if (rule.method === 'VENDOR_DIRECT') {
    const vendor = VENDORS[rule.vendorId];
    return {
      method: rule.method,
      vendor: vendor.name,
      shipsFrom: vendor.warehouse,
      leadDays: rule.leadDays,
    };
  }
  const node = FULFILLMENT_NODES[rule.nodeId];
  return {
    method: rule.method,
    node,
    shipsFrom: node.name,
    leadDays: node.handlingDays,
  };
}

module.exports = { FULFILLMENT_NODES, VENDORS, SOURCING, resolveSourcing };
