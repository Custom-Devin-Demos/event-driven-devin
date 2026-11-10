const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { tracer, incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const SERVICE = 'wm-order-routing-api';
const ROUTE = '/api/oncall/wealthorders/orders';
const RELEASE = 'wm-order-routing@2026.11.2';

/**
 * Advisory brokerage accounts the desk can trade, keyed by account id.
 */
const ACCOUNTS = new Map([
  ['HRP-TR-0158', { household: 'Harper household', label: 'Harper Family Trust', registration: 'Trust', discretion: 'advisory' }],
  ['HRP-JT-0412', { household: 'Harper household', label: 'Harper Joint Brokerage', registration: 'JTWROS', discretion: 'advisory' }],
  ['LPL-CO-0730', { household: 'Lin & Patel LLC', label: 'Lin & Patel LLC Operating', registration: 'Corporate', discretion: 'discretionary' }],
  ['OKF-IR-0281', { household: 'D. Okafor IRA', label: 'Okafor Rollover IRA', registration: 'IRA', discretion: 'advisory' }],
  ['WHF-JT-0614', { household: 'S. & R. Whitfield', label: 'Whitfield Joint Brokerage', registration: 'JTWROS', discretion: 'advisory' }],
  ['CHF-EN-0905', { household: 'Chen Foundation', label: 'Chen Foundation Endowment', registration: 'Foundation', discretion: 'discretionary' }],
]);

/**
 * Instruments as published by security master v2. `instrumentClass` is the
 * v2 classification code.
 */
const SECURITY_MASTER = new Map([
  ['MSFT', { name: 'Microsoft Corp', instrumentClass: 'EQ.US.CS', lotSize: 1 }],
  ['AAPL', { name: 'Apple Inc', instrumentClass: 'EQ.US.CS', lotSize: 1 }],
  ['NVDA', { name: 'NVIDIA Corp', instrumentClass: 'EQ.US.CS', lotSize: 1 }],
  ['JPM', { name: 'JPMorgan Chase & Co', instrumentClass: 'EQ.US.CS', lotSize: 1 }],
  ['VTI', { name: 'Vanguard Total Stock Market ETF', instrumentClass: 'EQ.US.ETF', lotSize: 1 }],
  ['MUB', { name: 'iShares National Muni Bond ETF', instrumentClass: 'EQ.US.ETF', lotSize: 1 }],
]);

/**
 * Smart order router destinations per instrument class.
 */
const ROUTING_RULES = {
  US_EQUITY: { primaryVenue: 'SOR-NMS', fallbackVenue: 'ATS-BLOCK', maxClipShares: 5000 },
  US_ETF: { primaryVenue: 'SOR-ETF', fallbackVenue: 'RFQ-ETF', maxClipShares: 10000 },
};

function rejectOrder(message) {
  return Object.assign(new Error(message), { code: 'INVALID_ORDER' });
}

function validateOrder(order = {}) {
  const accountId = typeof order.accountId === 'string' ? order.accountId : '';
  const symbol = typeof order.symbol === 'string' ? order.symbol.trim().toUpperCase() : '';
  const account = ACCOUNTS.get(accountId);
  const instrument = SECURITY_MASTER.get(symbol);
  const side = order.side === 'sell' ? 'sell' : order.side === 'buy' ? 'buy' : null;
  const quantity = Number(order.quantity);
  const orderType = order.orderType === 'market' ? 'market' : order.orderType === 'limit' ? 'limit' : null;
  const limitPrice = orderType === 'limit' ? Number(order.limitPrice) : null;
  const timeInForce = order.timeInForce === 'gtc' ? 'gtc' : 'day';
  if (!account) throw rejectOrder('Choose an advisory account from the client book.');
  if (!instrument) throw rejectOrder(`${symbol || 'Symbol'} is not tradable from the Advisor Desk.`);
  if (!side || !orderType) throw rejectOrder('Choose a side and an order type.');
  if (!Number.isInteger(quantity) || quantity <= 0 || quantity > 100000) {
    throw rejectOrder('Quantity must be a whole number of shares between 1 and 100,000.');
  }
  if (orderType === 'limit' && !(Number.isFinite(limitPrice) && limitPrice > 0)) {
    throw rejectOrder('Enter a positive limit price.');
  }
  return { accountId, account, symbol, instrument, side, quantity, orderType, limitPrice, timeInForce };
}

function routingKeyFor(instrument) {
  return instrument.instrumentClass;
}

function selectVenue(order) {
  const rule = ROUTING_RULES[routingKeyFor(order.instrument)];
  const clips = Math.ceil(order.quantity / rule.maxClipShares);
  return { venue: rule.primaryVenue, fallbackVenue: rule.fallbackVenue, clips };
}

/**
 * Route an advisor equity order to the smart order router.
 */
async function submitOrder(data) {
  const order = validateOrder(data);
  const orderId = uuidv4();
  const started = Date.now();
  const tags = { service: SERVICE, route: ROUTE, release: RELEASE };
  return tracer.trace('wm.order_routing.submit', { service: SERVICE, resource: `POST ${ROUTE}`, tags }, async () => {
    try {
      const routing = selectVenue(order);
      const durationMs = Date.now() - started;
      incrementMetric('wm.order_routing.success', tags);
      recordTiming('wm.order_routing.latency', durationMs, tags);
      logger.info('Advisor order routed', { ...tags, orderId, accountId: order.accountId, symbol: order.symbol, venue: routing.venue });
      return {
        success: true,
        orderId,
        status: 'ROUTED',
        confirmation: `WM-ORD-${orderId.slice(0, 8).toUpperCase()}`,
        accountId: order.accountId,
        symbol: order.symbol,
        side: order.side,
        quantity: order.quantity,
        orderType: order.orderType,
        limitPrice: order.limitPrice,
        timeInForce: order.timeInForce,
        venue: routing.venue,
        routedAt: new Date().toISOString(),
      };
    } catch (error) {
      incrementMetric('wm.order_routing.failure', { ...tags, errorClass: error.name });
      recordTiming('wm.order_routing.latency', Date.now() - started, { ...tags, error: 'true' });
      logger.error('Advisor order routing failed', {
        ...tags, orderId, accountId: order.accountId, symbol: order.symbol,
        error: error.message, errorClass: error.name, stack: error.stack,
      });
      Sentry.captureException(error, { tags, extra: { orderId, accountId: order.accountId, symbol: order.symbol } });
      throw error;
    }
  });
}

module.exports = { ACCOUNTS, SECURITY_MASTER, submitOrder };
