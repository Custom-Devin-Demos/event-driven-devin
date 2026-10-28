/**
 * Pre-sign preflight for sweep checkouts: an in-process port of the Seaport 1.6
 * reference fulfillment path (ReferenceOrderCombiner#_fulfillAvailableAdvancedOrders,
 * ReferenceFulfillmentApplier#_aggregateValidFulfillment*Items). Orders are run
 * through the same aggregation and consideration accounting the contract
 * applies, so a bundle that would revert on-chain is rejected before the
 * wallet is asked to sign, without an RPC round trip.
 */

const REVERTS = {
  ConsiderationNotMet: { selector: '0xa5f54208', signature: 'ConsiderationNotMet(uint256,uint256,uint256)' },
  InvalidFulfillmentComponentData: { selector: '0x7fda7279', signature: 'InvalidFulfillmentComponentData()' },
  NoSpecifiedOrdersAvailable: { selector: '0xd5da9a1b', signature: 'NoSpecifiedOrdersAvailable()' },
  InsufficientNativeTokensSupplied: { selector: '0x8ffff980', signature: 'InsufficientNativeTokensSupplied()' },
};

const BASE_GAS = 118000;
const GAS_PER_ORDER = 64000;

class SeaportRevert extends Error {
  constructor(name, args = {}) {
    super(name);
    this.revert = { name, ...REVERTS[name], args };
  }
}

/** Working copy of each order with mutable amounts, as the contract keeps in memory. */
function toOrdersToExecute(orders) {
  return orders.map((order) => ({
    offerer: order.offerer,
    numerator: 1n,
    spentItems: order.offer.map((item) => ({ ...item, amount: BigInt(item.amount) })),
    receivedItems: order.consideration.map((item) => ({ ...item, amount: BigInt(item.amount) })),
  }));
}

function sameItem(a, b) {
  return a.itemType === b.itemType && a.token === b.token && String(a.identifier) === String(b.identifier);
}

function aggregateOfferItems(ordersToExecute, components, recipient) {
  let execution = null;
  for (const { orderIndex, itemIndex } of components) {
    const order = ordersToExecute[orderIndex];
    if (!order) throw new SeaportRevert('InvalidFulfillmentComponentData');
    if (order.numerator === 0n) continue;
    const item = order.spentItems[itemIndex];
    if (!item) throw new SeaportRevert('InvalidFulfillmentComponentData');
    if (!execution) {
      execution = { item: { itemType: item.itemType, token: item.token, identifier: item.identifier, amount: 0n }, offerer: order.offerer, recipient };
    } else if (!sameItem(execution.item, item) || execution.offerer !== order.offerer) {
      throw new SeaportRevert('InvalidFulfillmentComponentData');
    }
    execution.item.amount += item.amount;
    item.amount = 0n;
  }
  return execution;
}

/**
 * Sum every available component of one consideration fulfillment into a single
 * transfer and mark each component as paid. All components must name the same
 * item and recipient as the first available one.
 */
function aggregateConsiderationItems(ordersToExecute, components, fulfiller) {
  let execution = null;
  let receivedItems;
  for (const { orderIndex, itemIndex } of components) {
    const order = ordersToExecute[orderIndex];
    if (!order) throw new SeaportRevert('InvalidFulfillmentComponentData');
    if (order.numerator === 0n) continue;
    if (!execution) receivedItems = order.receivedItems;
    const item = order.receivedItems[itemIndex];
    if (!item) throw new SeaportRevert('InvalidFulfillmentComponentData');
    if (!execution) {
      execution = {
        item: { itemType: item.itemType, token: item.token, identifier: item.identifier, amount: 0n },
        offerer: fulfiller,
        recipient: item.recipient,
      };
    } else if (!sameItem(execution.item, item) || execution.recipient !== item.recipient) {
      throw new SeaportRevert('InvalidFulfillmentComponentData');
    }
    execution.item.amount += item.amount;
    receivedItems[itemIndex].amount = 0n;
  }
  return execution;
}

/** Every consideration item of every available order must be fully paid. */
function validateConsiderationMet(ordersToExecute) {
  ordersToExecute.forEach((order, orderIndex) => {
    if (order.numerator === 0n) return;
    order.receivedItems.forEach((item, considerationIndex) => {
      if (item.amount !== 0n) {
        throw new SeaportRevert('ConsiderationNotMet', { orderIndex, considerationIndex, shortfallAmount: item.amount.toString() });
      }
    });
  });
}

/**
 * Simulate fulfillAvailableAdvancedOrders(orders, [], offerFulfillments,
 * considerationFulfillments, ..., maximumFulfilled = orders.length) for
 * `fulfiller` paying `value` in native currency.
 */
function simulateFulfillAvailableAdvancedOrders(orders, { offerFulfillments, considerationFulfillments }, { fulfiller, value } = {}) {
  try {
    const ordersToExecute = toOrdersToExecute(orders);
    if (!ordersToExecute.some((o) => o.numerator !== 0n)) throw new SeaportRevert('NoSpecifiedOrdersAvailable');

    const executions = [];
    for (const components of offerFulfillments) {
      const execution = aggregateOfferItems(ordersToExecute, components, fulfiller);
      if (execution && execution.item.amount !== 0n) executions.push(execution);
    }
    for (const components of considerationFulfillments) {
      const execution = aggregateConsiderationItems(ordersToExecute, components, fulfiller);
      if (execution && execution.item.amount !== 0n) executions.push(execution);
    }

    validateConsiderationMet(ordersToExecute);

    if (value !== undefined) {
      const nativeOut = executions
        .filter((e) => e.item.itemType === 0 && e.offerer === fulfiller)
        .reduce((sum, e) => sum + e.item.amount, 0n);
      if (nativeOut > BigInt(value)) throw new SeaportRevert('InsufficientNativeTokensSupplied');
    }

    return { success: true, executions, gasEstimate: BASE_GAS + orders.length * GAS_PER_ORDER };
  } catch (error) {
    if (error instanceof SeaportRevert) return { success: false, revert: error.revert };
    throw error;
  }
}

module.exports = {
  simulateFulfillAvailableAdvancedOrders,
  aggregateConsiderationItems,
  aggregateOfferItems,
  validateConsiderationMet,
  toOrdersToExecute,
  REVERTS,
};
