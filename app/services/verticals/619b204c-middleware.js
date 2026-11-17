const fulfillment = require('./619b204c-fulfillment');

class FulfillmentApiError extends Error {
  constructor(response, request) {
    super(`${response.status} ${response.body.error}: ${response.body.message} (${fulfillment.ENDPOINT}, order ${request.orderNumber})`);
    this.name = 'FulfillmentApiError';
    this.status = response.status;
    this.orderNumber = request.orderNumber;
  }
}

function screenTradeCompliance(order, catalog) {
  for (const line of order.lines) {
    const item = catalog.find((c) => c.sku === line.sku);
    if (!item || !item.approvedCountries.includes(order.country)) {
      return {
        holdCode: 'TRADE_COMPLIANCE',
        reason: `${item ? item.name : line.sku} is not approved for destination country ${order.country}`,
      };
    }
  }
  return null;
}

function buildRequest(order) {
  return {
    orderNumber: order.orderNumber,
    customer: order.customer,
    destinationCountry: order.country,
    source: order.source,
    lines: order.lines.map((l) => ({
      lineNumber: l.lineNumber, sku: l.sku, quantity: l.quantity, siteId: l.siteId,
    })),
  };
}

async function sendOrder(order, catalog) {
  const hold = screenTradeCompliance(order, catalog);
  if (hold) {
    return { outcome: 'HOLD', ...hold, calls: 0, lines: order.lines.length };
  }
  const request = buildRequest(order);
  const response = await fulfillment.post(request);
  if (response.status !== 200) {
    throw new FulfillmentApiError(response, request);
  }
  return {
    outcome: 'FULFILLED',
    entitlementId: response.body.entitlementId,
    calls: 1,
    lines: request.lines.length,
  };
}

module.exports = {
  sendOrder, buildRequest, screenTradeCompliance, FulfillmentApiError,
};
