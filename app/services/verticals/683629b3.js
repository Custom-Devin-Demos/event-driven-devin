const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { postMessage, findChannelByNameFragment } = require('../slack');
const { getCustomerConfig } = require('../../../config/customers');
const { PRODUCTS, MEMORY_OPTIONS, STORAGE_OPTIONS, DEMO_ACCOUNT } = require('./683629b3-catalog');

/**
 * Dell.com storefront (COG-GTM/dell-com-demo, hosted copy). The Vite/React
 * build of that repo is served at /683629b3/app and talks to the JSON API
 * under /api/683629b3: catalog, always-signed-in sample account, configuration
 * quotes, Place order and the Contact Us bug report. Place order is the on-call
 * trigger; the bug report goes to #dell-com-feedback and never pages anyone.
 */
const CUSTOMER = '683629b3';
const API_BASE = `/api/${CUSTOMER}`;
const ROUTE = `${API_BASE}/orders`;
const FEEDBACK_ROUTE = `${API_BASE}/feedback`;
const SERVICE = `customer-${CUSTOMER}-web`;
const APP_WEB_PATH = `/${CUSTOMER}/app`;
const SCENARIO = 'checkout-unavailable';
const CHECKOUT_ERROR = 'unable to process your order';
const CHECKOUT_HOLD_MS = 500;
const INCIDENT_WINDOW_MS = 60 * 1000;
const FEEDBACK_LIMIT = { max: 5, windowMs: 60 * 1000 };

const ONCALL_CHANNEL = { id: 'C0CAX4SHG6M', name: '#dell-oncall' };
const FEEDBACK_CHANNEL = { name: 'dell-com-feedback', label: '#dell-com-feedback', envVar: 'SLACK_DELL_COM_FEEDBACK_CHANNEL_ID' };
const DISCLAIMER = 'This is not a Dell Technologies website. Internal demonstration only; no real orders, accounts or payments.';

/** Demo owner: on-call and session owner for every checkout incident. */
const OWNER = {
  slackMemberId: 'U0AS6QZDFD0',
  email: 'wes.convery@cognition.ai',
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is Place order on the Dell.com storefront demo:',
  `- Service: \`app/services/verticals/${CUSTOMER}.js\` (\`placeOrder\` \u2192 \`reserveFulfillment\`)`,
  `- Demo data: \`app/services/verticals/${CUSTOMER}-catalog.js\``,
  `- Route: \`app/routes/verticals/${CUSTOMER}.js\``,
  `- Page: the prebuilt app in \`app/public/verticals/${CUSTOMER}-app/\` (served at \`${APP_WEB_PATH}\`, alias \`/dell-com\`); do not edit the build`,
  '',
  'Every valid cart (any laptop, memory, storage, color and quantity) must place a mock order; today every',
  'Place order fails with HTTP 503 "unable to process your order" after a short loading state.',
  'Fix the data mismatch at its source, make `reserveFulfillment` fail with a descriptive error for a lane it',
  'cannot resolve instead of dereferencing undefined, and add a test that every catalog configuration checks out.',
  `Run \`npx jest tests/${CUSTOMER}-storefront.test.js --runInBand\` and \`npm run lint\`.`,
  `Verify Cart \u2192 Place order at \`${APP_WEB_PATH}\` shows the mock receipt for every laptop.`,
  'Open a pull request against `main` with the fix.',
].join('\n');

/**
 * Fulfillment lanes from the order-management service. Every laptop in the
 * catalog is configure-to-order and ships from the North America lane.
 */
const FULFILLMENT_LANES = {
  'cto-na': { name: 'Configure-to-order \u2014 North America', leadDays: 7, carrier: 'Standard delivery' },
  'stock-na': { name: 'In stock \u2014 North America', leadDays: 2, carrier: 'Express delivery' },
};

const FULFILLMENT_REGION = 'na';

/**
 * Lane codes are versioned per region since the storefront-checkout
 * 2026.11.1 release (lane schema v2).
 */
function laneCodeFor(_item) {
  return `cto-${FULFILLMENT_REGION}-v2`;
}

function validationError(message, code = 'INVALID_CART') {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function feedbackError(message, statusCode = 400) {
  const error = new Error(message);
  error.name = 'FeedbackError';
  error.code = 'FEEDBACK_REJECTED';
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function clip(value, max) {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function quoteItem(input) {
  if (!input || typeof input !== 'object') throw validationError('Choose a product configuration.');
  const product = PRODUCTS.find((p) => p.id === input.productId);
  const memory = MEMORY_OPTIONS.find((o) => o.value === input.memory);
  const storage = STORAGE_OPTIONS.find((o) => o.value === input.storage);
  const quantity = input.quantity == null ? 1 : input.quantity;
  if (!product || !memory || !storage || !product.colors.includes(input.color)
    || !Number.isInteger(quantity) || quantity < 1 || quantity > 10) {
    throw validationError('Choose a valid product, memory, storage, color and quantity (1\u201310).');
  }
  const unitPriceCents = product.priceCents + memory.priceCents + storage.priceCents;
  return {
    productId: product.id,
    name: product.name,
    image: product.image,
    memory: memory.value,
    storage: storage.value,
    color: input.color,
    quantity,
    unitPriceCents,
    totalCents: unitPriceCents * quantity,
  };
}

function quoteCart(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) {
    throw validationError('Your cart must contain between 1 and 20 configurations.');
  }
  const items = input.map((item) => quoteItem(item));
  const subtotalCents = items.reduce((sum, item) => sum + item.totalCents, 0);
  const taxCents = Math.round(subtotalCents * 0.08);
  return { items, subtotalCents, shippingCents: 0, taxCents, totalCents: subtotalCents + taxCents };
}

function reserveFulfillment(quote) {
  return quote.items.map((item) => {
    const lane = FULFILLMENT_LANES[laneCodeFor(item)];
    return {
      productId: item.productId,
      lane: lane.name,
      carrier: lane.carrier,
      estimatedDays: lane.leadDays,
    };
  });
}

function getOrder(orderId) {
  return DEMO_ACCOUNT.orders.find((order) => order.id === orderId) || null;
}

let lastIncidentAt = 0;

function resetIncidentWindow() {
  lastIncidentAt = 0;
}

function raiseIncident(error, quote, requestId) {
  const now = Date.now();
  if (now - lastIncidentAt < INCIDENT_WINDOW_MS) {
    logger.info('Dell.com checkout failure joined the open incident', { requestId, scenario: SCENARIO });
    return Promise.resolve(null);
  }
  lastIncidentAt = now;

  const tags = {
    route: ROUTE,
    service: SERVICE,
    step: 'reserve-fulfillment',
    scenario: SCENARIO,
    items: String(quote.items.length),
  };

  Sentry.captureException(error, {
    tags: { ...tags, alert_path: 'instant' },
    extra: { requestId, products: quote.items.map((item) => item.productId) },
  });

  const config = getCustomerConfig(CUSTOMER);
  return createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: `app/services/verticals/${CUSTOMER}.js \u2014 reserveFulfillment`,
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinEmail: OWNER.email,
    devinOrgId: config.devinOrgId || process.env.DEVIN_ORG_ID || undefined,
    slackMemberIdFallback: OWNER.slackMemberId,
    service: SERVICE,
    verticalLabel: 'Dell.com storefront',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
    extra: { requestId, products: quote.items.map((item) => item.productId) },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || `${SERVICE}@2026.11.1`,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).catch((alertError) => {
    logger.error('Failed to create Devin session for Dell.com checkout failure', {
      error: alertError.message,
      requestId,
    });
    return null;
  });
}

/**
 * Place order: price the cart, hold for the payment authorization round
 * trip, then reserve fulfillment. A failure is captured to Sentry and raised
 * as a #dell-oncall alert + Devin session before it is rethrown.
 */
async function placeOrder(data, { hold = CHECKOUT_HOLD_MS } = {}) {
  const startTime = Date.now();
  const requestId = `DCO-${uuidv4().slice(0, 8).toUpperCase()}`;
  const quote = quoteCart(data && data.items);

  logger.info('Dell.com checkout request', {
    requestId, items: quote.items.length, totalCents: quote.totalCents, service: SERVICE, route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, hold));
    const fulfillment = reserveFulfillment(quote);
    incrementMetric('storefront.checkout.success', { route: ROUTE, customer: CUSTOMER });
    recordTiming('storefront.checkout.latency', Date.now() - startTime, { route: ROUTE });
    return {
      ...quote,
      orderId: `DEMO-${uuidv4().slice(0, 8).toUpperCase()}`,
      fulfillment,
      requestId,
      demo: true,
    };
  } catch (error) {
    incrementMetric('storefront.checkout.failure', { route: ROUTE, customer: CUSTOMER, errorClass: error.name });
    recordTiming('storefront.checkout.latency', Date.now() - startTime, { route: ROUTE, error: 'true' });
    logger.error('Dell.com checkout failed', {
      requestId,
      items: quote.items.length,
      error: error.message,
      errorClass: error.name,
      service: SERVICE,
    });
    error.sessionPromise = raiseIncident(error, quote, requestId);
    error.requestId = requestId;
    error.code = 'CHECKOUT_UNAVAILABLE';
    error.statusCode = 503;
    error.publicMessage = CHECKOUT_ERROR;
    throw error;
  }
}

function refreshOrderStatus(orderId) {
  const order = getOrder(orderId);
  if (!order) {
    const error = validationError('Demo order not found.', 'ORDER_NOT_FOUND');
    error.statusCode = 404;
    throw error;
  }
  return { ...order, refreshedAt: new Date().toISOString(), demo: true };
}

/* ----------------------------------------------------------------------------
 * Contact Us → bug report → #dell-com-feedback
 * ------------------------------------------------------------------------- */

const feedbackWindow = [];
let feedbackChannelPromise = null;

function resetFeedbackState() {
  feedbackWindow.length = 0;
  feedbackChannelPromise = null;
}

function feedbackMode(env = process.env) {
  return env.SLACK_BOT_TOKEN ? 'live' : 'dry-run';
}

function reserveFeedbackSlot(now = Date.now()) {
  while (feedbackWindow.length && now - feedbackWindow[0] >= FEEDBACK_LIMIT.windowMs) feedbackWindow.shift();
  if (feedbackWindow.length >= FEEDBACK_LIMIT.max) return false;
  feedbackWindow.push(now);
  return true;
}

/**
 * The feedback channel is never the on-call channel: a configured id is used
 * as-is, otherwise the bot looks #dell-com-feedback up by name once.
 */
async function resolveFeedbackChannel(token) {
  const configured = (process.env[FEEDBACK_CHANNEL.envVar] || '').trim();
  if (configured) {
    if (configured === ONCALL_CHANNEL.id) {
      throw new Error(`${FEEDBACK_CHANNEL.envVar} must not be the on-call channel`);
    }
    return configured;
  }
  if (!feedbackChannelPromise) {
    feedbackChannelPromise = findChannelByNameFragment(token, FEEDBACK_CHANNEL.name)
      .then((match) => {
        if (!match || match.name !== FEEDBACK_CHANNEL.name || match.id === ONCALL_CHANNEL.id) {
          throw new Error(`${FEEDBACK_CHANNEL.label} not found`);
        }
        return match.id;
      })
      .catch((error) => {
        feedbackChannelPromise = null;
        throw error;
      });
  }
  return feedbackChannelPromise;
}

async function submitFeedback(input) {
  const title = clip(input && input.title, 200);
  const description = clip(input && input.description, 4000);
  const page = input && input.page;
  if (title.length < 3 || title.length > 120) {
    throw feedbackError('Enter a bug summary between 3 and 120 characters.');
  }
  if (description.length < 10 || description.length > 2000) {
    throw feedbackError('Describe the bug in 10 to 2,000 characters.');
  }
  if (typeof page !== 'string' || page.length > 200 || !/^\/[a-zA-Z0-9/_-]*$/.test(page)) {
    throw feedbackError('Report the bug from a valid page in this demo.');
  }
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) {
    logger.warn('Dell.com bug report not sent \u2014 SLACK_BOT_TOKEN not configured', { route: FEEDBACK_ROUTE });
    return { status: 'dry-run', channel: FEEDBACK_CHANNEL.label };
  }
  if (!reserveFeedbackSlot()) {
    throw feedbackError('Too many bug reports. Please wait a minute before trying again.', 429);
  }
  let channel;
  try {
    channel = await resolveFeedbackChannel(token);
  } catch (error) {
    logger.error('Dell.com feedback channel unavailable', { error: error.message, route: FEEDBACK_ROUTE });
    throw feedbackError(`Bug reporting is not connected to ${FEEDBACK_CHANNEL.label} on this server.`, 503);
  }
  const blocks = [
    { type: 'header', text: { type: 'plain_text', text: 'Dell.com demo \u2014 Bug report' } },
    { type: 'section', text: { type: 'plain_text', text: title } },
    { type: 'section', text: { type: 'plain_text', text: description } },
    { type: 'context', elements: [{ type: 'plain_text', text: `Page: ${page} \u00b7 Internal demonstration` }] },
  ];
  try {
    const ts = await postMessage(token, channel, `Dell.com demo \u2014 Bug report: ${title}`, blocks);
    logger.info('Dell.com bug report posted', { channel, ts, route: FEEDBACK_ROUTE });
  } catch (error) {
    logger.error('Dell.com bug report failed', { error: error.message, route: FEEDBACK_ROUTE });
    throw feedbackError(`Unable to confirm delivery. Check ${FEEDBACK_CHANNEL.label} before retrying.`, 502);
  }
  incrementMetric('storefront.feedback.sent', { route: FEEDBACK_ROUTE, customer: CUSTOMER });
  return { status: 'sent', channel: FEEDBACK_CHANNEL.label };
}

function publicConfig() {
  return {
    mode: 'live',
    scenario: SCENARIO,
    disclaimer: DISCLAIMER,
    channel: ONCALL_CHANNEL.name,
    feedbackMode: feedbackMode(),
    feedbackChannel: FEEDBACK_CHANNEL.label,
  };
}

module.exports = {
  CUSTOMER,
  API_BASE,
  ROUTE,
  FEEDBACK_ROUTE,
  SERVICE,
  APP_WEB_PATH,
  SCENARIO,
  CHECKOUT_ERROR,
  CHECKOUT_HOLD_MS,
  INCIDENT_WINDOW_MS,
  ONCALL_CHANNEL,
  FEEDBACK_CHANNEL,
  OWNER,
  REMEDIATION_DIRECTIVE,
  FULFILLMENT_LANES,
  PRODUCTS,
  MEMORY_OPTIONS,
  STORAGE_OPTIONS,
  DEMO_ACCOUNT,
  quoteItem,
  quoteCart,
  reserveFulfillment,
  placeOrder,
  refreshOrderStatus,
  submitFeedback,
  publicConfig,
  resetIncidentWindow,
  resetFeedbackState,
};
