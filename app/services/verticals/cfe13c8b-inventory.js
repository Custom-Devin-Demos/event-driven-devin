const BRANCHES = [
  { id: 'peoria', name: 'Peoria Parts Counter', city: 'Peoria, IL', feedVersion: '2.1', feedBatch: 'PEO-8821' },
  { id: 'decatur', name: 'Decatur Parts Counter', city: 'Decatur, IL', feedVersion: '1.7', feedBatch: 'DEC-6394' },
];

const WORK_ORDER = {
  id: 'WO-41872',
  machine: '320 Hydraulic Excavator',
  asset: 'EX-320-17',
  part: { number: '465-6505', description: 'Hydraulic filter element', quantity: 1 },
};

const FEEDS = {
  peoria: {
    '465-6505': { stock: { counts: { onHand: 8, reserved: 3 } }, pickup: { window: { readyBy: 'Today after 2:00 PM' } } },
  },
  decatur: {
    '465-6505': { stock: { onHand: 6, reserved: 2 }, pickup: { readyBy: 'Today after 3:30 PM' } },
  },
};

function availableQuantity(stock) {
  if (!Number.isInteger(stock.onHand) || !Number.isInteger(stock.reserved)) {
    throw new TypeError('Inventory record has invalid on-hand or reserved quantity');
  }
  return Math.max(0, stock.onHand - stock.reserved);
}

function pickupWindow(pickup) {
  if (typeof pickup.readyBy !== 'string' || !pickup.readyBy.trim()) {
    throw new TypeError('Inventory record has no pickup window');
  }
  return pickup.readyBy;
}

function readAvailability(branchId, partNumber) {
  const item = FEEDS[branchId][partNumber];
  const available = availableQuantity(item.stock);
  return { available, readyBy: available > 0 ? pickupWindow(item.pickup) : null };
}

module.exports = { BRANCHES, WORK_ORDER, readAvailability };
