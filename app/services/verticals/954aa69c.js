const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const {
  postMessage, joinChannel, buildAlertBlocks, buildAlertText, resolveOnCallMember,
} = require('../slack');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * Bloomberg Terminal look-alike (page app/public/verticals/954aa69c.html).
 * The page drives the EMSX <GO> execution blotter through the JSON API under
 * /api/954aa69c: staged orders, staging a new order and routing an order to a
 * broker. Routing is the on-call trigger; everything else stays healthy.
 */
const CUSTOMER = '954aa69c';
const API_BASE = `/api/${CUSTOMER}`;
const ROUTE = `${API_BASE}/routes`;
const SERVICE = `customer-${CUSTOMER}-emsx`;
const PAGE_PATH = `/${CUSTOMER}`;
const SCENARIO = 'emsx-route-unavailable';
const ROUTE_ERROR = 'Unable to route order. Request could not be processed.';
const ROUTE_HOLD_MS = 500;
const INCIDENT_WINDOW_MS = 60 * 1000;
const MAX_QUANTITY = 5_000_000;
const MAX_STAGED_ORDERS = 40;

const ONCALL_CHANNEL = { id: 'C0CKXTAMWQY', name: '#bloomberg-oncall' };
const DISCLAIMER = 'This is not a Bloomberg product. Internal demonstration only; no real orders, accounts or market data.';

/** Demo owner: on-call for every routing incident. */
const OWNER = {
  slackMemberId: 'U0AS6QZDFD0',
  email: 'wes.convery@cognition.ai',
};

/**
 * Where the responder should look. The card is alert-only: the Bloomberg
 * Alert Responder (Devin Oncall on #bloomberg-oncall) triages it and opens
 * the fix PR, so no app-side Devin session is created here.
 */
const RESPONDER_NOTES = [
  'Repo: https://github.com/COG-GTM/event-driven-devin',
  `Code path: app/services/verticals/${CUSTOMER}.js (routeOrder \u2192 openBrokerSession); demo page ${PAGE_PATH} (alias /bloomberg-terminal), EMSX <GO> \u2192 Route.`,
].join('\n');

const SECURITIES = {
  'AAPL US': { ticker: 'AAPL US', name: 'APPLE INC', last: 231.42, currency: 'USD', exchange: 'NASDAQ GS' },
  'MSFT US': { ticker: 'MSFT US', name: 'MICROSOFT CORP', last: 428.15, currency: 'USD', exchange: 'NASDAQ GS' },
  'NVDA US': { ticker: 'NVDA US', name: 'NVIDIA CORP', last: 138.07, currency: 'USD', exchange: 'NASDAQ GS' },
  'JPM US': { ticker: 'JPM US', name: 'JPMORGAN CHASE & CO', last: 243.88, currency: 'USD', exchange: 'New York' },
  'XOM US': { ticker: 'XOM US', name: 'EXXON MOBIL CORP', last: 118.63, currency: 'USD', exchange: 'New York' },
  'TSLA US': { ticker: 'TSLA US', name: 'TESLA INC', last: 342.74, currency: 'USD', exchange: 'NASDAQ GS' },
  'AMZN US': { ticker: 'AMZN US', name: 'AMAZON.COM INC', last: 205.31, currency: 'USD', exchange: 'NASDAQ GS' },
  'IBM US': { ticker: 'IBM US', name: 'INTL BUSINESS MACHINES CORP', last: 214.6, currency: 'USD', exchange: 'New York' },
};

const BROKERS = {
  MSCO: { code: 'MSCO', name: 'Morgan Stanley', strategies: ['VWAP', 'TWAP', 'POV', 'DMA'] },
  GSCO: { code: 'GSCO', name: 'Goldman Sachs', strategies: ['VWAP', 'TWAP', 'SONAR', 'DMA'] },
  JPMS: { code: 'JPMS', name: 'J.P. Morgan Securities', strategies: ['VWAP', 'AQUA', 'DMA'] },
  CITI: { code: 'CITI', name: 'Citigroup Global Markets', strategies: ['VWAP', 'DAGGER', 'DMA'] },
};

/**
 * Broker FIX sessions from the EMSX route gateway. Every broker in the
 * blotter takes equity flow over its own session.
 */
const FIX_SESSIONS = {
  'MSCO.EQ': { senderCompId: 'BLPEMSX', targetCompId: 'MSCOALGO', fixVersion: 'FIX.4.2', venue: 'Morgan Stanley Electronic Trading' },
  'GSCO.EQ': { senderCompId: 'BLPEMSX', targetCompId: 'GSCOALGO', fixVersion: 'FIX.4.2', venue: 'Goldman Sachs Electronic Trading' },
  'JPMS.EQ': { senderCompId: 'BLPEMSX', targetCompId: 'JPMSALGO', fixVersion: 'FIX.4.2', venue: 'J.P. Morgan Electronic Client Solutions' },
  'CITI.EQ': { senderCompId: 'BLPEMSX', targetCompId: 'CITIALGO', fixVersion: 'FIX.4.2', venue: 'Citi Electronic Execution' },
};

const SESSION_ASSET_CLASS = 'EQ';

/**
 * Session keys carry the FIX dialect since the emsx-route-gateway 2026.11.2
 * release (broker sessions moving to FIX 5.0 SP2).
 */
function sessionKeyFor(broker) {
  return `${broker.code}.${SESSION_ASSET_CLASS}.FIX50SP2`;
}

const SIDES = ['BUY', 'SELL'];
const ORDER_TYPES = ['MKT', 'LMT'];
const TIFS = ['DAY', 'GTC', 'IOC'];

const SEED_ORDERS = [
  { ticker: 'AAPL US', side: 'BUY', quantity: 250000, orderType: 'LMT', limitPrice: 231.5, tif: 'DAY', broker: 'MSCO', strategy: 'VWAP', account: 'GLOBAL EQ LONG ONLY', trader: 'AMORGAN' },
  { ticker: 'NVDA US', side: 'BUY', quantity: 400000, orderType: 'MKT', limitPrice: null, tif: 'DAY', broker: 'GSCO', strategy: 'VWAP', account: 'US GROWTH FUND', trader: 'AMORGAN' },
  { ticker: 'JPM US', side: 'SELL', quantity: 180000, orderType: 'LMT', limitPrice: 243.75, tif: 'DAY', broker: 'JPMS', strategy: 'AQUA', account: 'US VALUE FUND', trader: 'AMORGAN' },
  { ticker: 'MSFT US', side: 'BUY', quantity: 120000, orderType: 'LMT', limitPrice: 428.2, tif: 'DAY', broker: 'MSCO', strategy: 'TWAP', account: 'GLOBAL EQ LONG ONLY', trader: 'AMORGAN' },
  { ticker: 'XOM US', side: 'SELL', quantity: 300000, orderType: 'MKT', limitPrice: null, tif: 'DAY', broker: 'CITI', strategy: 'VWAP', account: 'ENERGY SELECT', trader: 'AMORGAN' },
  { ticker: 'TSLA US', side: 'BUY', quantity: 90000, orderType: 'LMT', limitPrice: 342.5, tif: 'DAY', broker: 'GSCO', strategy: 'SONAR', account: 'US GROWTH FUND', trader: 'AMORGAN' },
];

let orders = [];
let nextSequence = 0;
let lastIncidentAt = 0;

function notionalOf(order) {
  const price = order.orderType === 'LMT' ? order.limitPrice : SECURITIES[order.ticker].last;
  return Math.round(price * order.quantity * 100) / 100;
}

function addOrder(fields) {
  nextSequence += 1;
  const order = {
    orderId: `EMSX-${4718200 + nextSequence}`,
    ...fields,
    name: SECURITIES[fields.ticker].name,
    currency: SECURITIES[fields.ticker].currency,
    status: 'STAGED',
    filled: 0,
    routeId: null,
  };
  order.notional = notionalOf(order);
  orders.push(order);
  return order;
}

function resetBlotter() {
  orders = [];
  nextSequence = 0;
  SEED_ORDERS.forEach((seed) => addOrder({ ...seed }));
}

function resetIncidentWindow() {
  lastIncidentAt = 0;
}

resetBlotter();

function validationError(message, code = 'INVALID_ORDER') {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function text(value) {
  return typeof value === 'string' ? value.trim().toUpperCase() : '';
}

function getBlotter() {
  const working = orders.filter((order) => order.status === 'STAGED');
  return {
    orders: orders.map((order) => ({ ...order })),
    brokers: Object.values(BROKERS).map((broker) => ({ ...broker, strategies: [...broker.strategies] })),
    securities: Object.values(SECURITIES).map((security) => ({ ...security })),
    summary: {
      staged: working.length,
      routed: orders.length - working.length,
      stagedNotional: Math.round(working.reduce((sum, order) => sum + order.notional, 0) * 100) / 100,
    },
  };
}

function stageOrder(input) {
  const data = input || {};
  const ticker = text(data.ticker);
  const side = text(data.side);
  const orderType = text(data.orderType) || 'MKT';
  const tif = text(data.tif) || 'DAY';
  const brokerCode = text(data.broker);
  const strategy = text(data.strategy);
  const quantity = data.quantity;
  const limitPrice = orderType === 'LMT' ? data.limitPrice : null;

  if (!SECURITIES[ticker]) throw validationError(`Unknown security: ${ticker || '(none)'}`, 'UNKNOWN_SECURITY');
  if (!SIDES.includes(side)) throw validationError('Side must be BUY or SELL', 'INVALID_SIDE');
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QUANTITY) {
    throw validationError(`Amount must be a whole number between 1 and ${MAX_QUANTITY.toLocaleString('en-US')}`, 'INVALID_QUANTITY');
  }
  if (!ORDER_TYPES.includes(orderType)) throw validationError('Order type must be MKT or LMT', 'INVALID_ORDER_TYPE');
  if (orderType === 'LMT' && !(Number.isFinite(limitPrice) && limitPrice > 0)) {
    throw validationError('Limit orders need a limit price', 'INVALID_LIMIT');
  }
  if (!TIFS.includes(tif)) throw validationError('TIF must be DAY, GTC or IOC', 'INVALID_TIF');
  const broker = BROKERS[brokerCode];
  if (!broker) throw validationError(`Unknown broker: ${brokerCode || '(none)'}`, 'UNKNOWN_BROKER');
  if (!broker.strategies.includes(strategy)) {
    throw validationError(`${broker.code} does not offer strategy ${strategy || '(none)'}`, 'UNKNOWN_STRATEGY');
  }
  if (orders.length >= MAX_STAGED_ORDERS) throw validationError('Blotter is full', 'BLOTTER_FULL');

  const order = addOrder({
    ticker, side, quantity, orderType, limitPrice, tif, broker: broker.code, strategy,
    account: 'GLOBAL EQ LONG ONLY', trader: 'AMORGAN',
  });
  incrementMetric('emsx.order.staged', { customer: CUSTOMER, side });
  return { ...order };
}

function openBrokerSession(order) {
  const broker = BROKERS[order.broker];
  const session = FIX_SESSIONS[sessionKeyFor(broker)];
  return {
    broker: broker.code,
    brokerName: broker.name,
    senderCompId: session.senderCompId,
    targetCompId: session.targetCompId,
    fixVersion: session.fixVersion,
    venue: session.venue,
  };
}

function slackToken(env = process.env) {
  return env.SLACK_ONCALL_BOT_TOKEN || env.SLACK_BOT_TOKEN || '';
}

/** Post once; if the bot is not yet in the (public) channel, join and retry once. */
async function postJoining(token, channel, messageText, blocks) {
  try {
    return await postMessage(token, channel, messageText, blocks);
  } catch (error) {
    if (!/not_in_channel/.test(error.message || '')) throw error;
    await joinChannel(token, channel);
    return postMessage(token, channel, messageText, blocks);
  }
}

/**
 * Post the alert card to #bloomberg-oncall only (the customer's
 * slackChannelId, never the shared SLACK_CHANNEL_ID) without the "Devin AI
 * (auto-investigating)" line: the channel's responder decides what to do.
 */
async function postAlertCard(alertData, requestId) {
  const token = slackToken();
  const channel = alertData.customerConfig.slackChannelId;
  if (!token || !channel) {
    logger.warn('Slack not configured \u2014 skipping EMSX route alert post', { requestId });
    return null;
  }
  await resolveOnCallMember(alertData);
  const messageText = `${buildAlertText(alertData)}\n${RESPONDER_NOTES}`;
  const blocks = [
    ...buildAlertBlocks(alertData, { includeDevinOnCall: false }),
    { type: 'context', elements: [{ type: 'mrkdwn', text: RESPONDER_NOTES }] },
  ];
  const ts = await postJoining(token, channel, messageText, blocks);
  logger.info('EMSX route alert posted', { channel, ts, requestId });
  return { ok: true, channel, ts };
}

/**
 * First failure per window posts one alert card to #bloomberg-oncall; later
 * failures join that incident. A window only stays open when the card was
 * actually delivered.
 */
function raiseIncident(error, order, requestId) {
  const now = Date.now();
  if (now - lastIncidentAt < INCIDENT_WINDOW_MS) {
    logger.info('EMSX route failure joined the open incident', { requestId, scenario: SCENARIO });
    return Promise.resolve(null);
  }
  lastIncidentAt = now;
  const reopenWindow = () => {
    if (lastIncidentAt === now) lastIncidentAt = 0;
  };

  const staged = orders.filter((item) => item.status === 'STAGED');
  const tags = {
    route: ROUTE,
    service: SERVICE,
    step: 'open-broker-session',
    scenario: SCENARIO,
    broker: order.broker,
    strategy: order.strategy,
  };
  const extra = {
    requestId,
    orderId: order.orderId,
    security: `${order.ticker} Equity`,
    side: order.side,
    quantity: order.quantity,
    orderNotionalUsd: order.notional,
    stagedOrdersUnrouted: staged.length,
    stagedNotionalUsd: Math.round(staged.reduce((sum, item) => sum + item.notional, 0) * 100) / 100,
  };

  Sentry.captureException(error, { tags: { ...tags, alert_path: 'instant' }, extra });

  const alertData = {
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: `app/services/verticals/${CUSTOMER}.js \u2014 openBrokerSession`,
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinEmail: OWNER.email,
    slackMemberIdFallback: OWNER.slackMemberId,
    service: SERVICE,
    verticalLabel: 'Bloomberg Terminal \u2014 EMSX order routing',
    customer: CUSTOMER,
    customerConfig: getCustomerConfig(CUSTOMER),
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra,
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.11.2`,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  };

  return postAlertCard(alertData, requestId)
    .then((result) => {
      if (!result) reopenWindow();
      return result;
    })
    .catch((alertError) => {
      logger.error('Failed to post EMSX route alert', { error: alertError.message, requestId });
      reopenWindow();
      return null;
    });
}

/**
 * Route a staged order: hold for the pre-trade compliance round trip, then
 * open the broker's FIX session and send the route. A failure is captured to
 * Sentry and posted as a #bloomberg-oncall alert card before it is rethrown;
 * the order stays staged.
 */
async function routeOrder(data, { hold = ROUTE_HOLD_MS } = {}) {
  const startTime = Date.now();
  const requestId = `EMR-${uuidv4().slice(0, 8).toUpperCase()}`;
  const orderId = text(data && data.orderId);
  const order = orders.find((item) => item.orderId === orderId);
  if (!order) throw validationError(`Unknown order: ${orderId || '(none)'}`, 'UNKNOWN_ORDER');
  if (order.status !== 'STAGED') throw validationError(`${order.orderId} is already routed`, 'ALREADY_ROUTED');

  logger.info('EMSX route request', {
    requestId, orderId, broker: order.broker, strategy: order.strategy, notional: order.notional, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, hold));
    const session = openBrokerSession(order);
    order.status = 'WORKING';
    order.routeId = `RT-${uuidv4().slice(0, 8).toUpperCase()}`;
    incrementMetric('emsx.route.success', { route: ROUTE, customer: CUSTOMER, broker: order.broker });
    recordTiming('emsx.route.latency', Date.now() - startTime, { route: ROUTE });
    return { ...order, session, requestId, demo: true };
  } catch (error) {
    incrementMetric('emsx.route.failure', { route: ROUTE, customer: CUSTOMER, errorClass: error.name });
    recordTiming('emsx.route.latency', Date.now() - startTime, { route: ROUTE, error: 'true' });
    logger.error('EMSX route failed', {
      requestId,
      orderId,
      broker: order.broker,
      strategy: order.strategy,
      notional: order.notional,
      error: error.message,
      errorClass: error.name,
      service: SERVICE,
    });
    error.alertPromise = raiseIncident(error, order, requestId);
    error.requestId = requestId;
    error.code = 'ROUTE_UNAVAILABLE';
    error.statusCode = 503;
    error.publicMessage = ROUTE_ERROR;
    throw error;
  }
}

function publicConfig() {
  return { mode: 'live', scenario: SCENARIO, disclaimer: DISCLAIMER, channel: ONCALL_CHANNEL.name };
}

module.exports = {
  CUSTOMER,
  API_BASE,
  ROUTE,
  SERVICE,
  PAGE_PATH,
  SCENARIO,
  ROUTE_ERROR,
  ROUTE_HOLD_MS,
  INCIDENT_WINDOW_MS,
  ONCALL_CHANNEL,
  OWNER,
  RESPONDER_NOTES,
  SECURITIES,
  BROKERS,
  FIX_SESSIONS,
  getBlotter,
  stageOrder,
  openBrokerSession,
  routeOrder,
  publicConfig,
  resetBlotter,
  resetIncidentWindow,
};
