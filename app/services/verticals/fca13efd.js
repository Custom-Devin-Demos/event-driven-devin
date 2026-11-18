const crypto = require('crypto');
const Sentry = require('@sentry/node');
const logger = require('../../telemetry/logger');
const { buildPrompt } = require('../devin-session');
const { createDevinSession } = require('../devin-api');
const { canCreateSession, reserveSession } = require('../session-rate-limiter');
const { getCustomerConfig } = require('../../../config/customers');

/**
 * Gearbox Entertainment on 2K — studio page BUY NOW (slug fca13efd).
 *
 * Clone of https://2k.com/studios/gearbox/. The hero BUY NOW opens the 2K buy
 * modal for Risk of Rain 2: Hallowed Concepts: the player picks a platform and
 * region and is routed to that retailer's store for the digital edition.
 *
 * Incident path: a failed BUY NOW is captured by Sentry and handed straight to a
 * Devin session through the Devin API. There is no Slack or Teams hop; the
 * remediation ends on Devin's pull request with the regression test passing.
 */
const CUSTOMER = 'fca13efd';
const SERVICE = 'gearbox-buy-now';
const ROUTE = 'POST /api/fca13efd/buy-now';
const CULPRIT = 'app/services/verticals/fca13efd.js — buildRetailerRedirect';
const TARGET_REPO = 'COG-GTM/event-driven-devin';
const DEVIN_COOLDOWN_MS = Number(process.env.GEARBOX_DEVIN_COOLDOWN_MS) || 10 * 60 * 1000;

const PRODUCTS = [
  { id: 'ror2-hallowed-concepts', label: 'Risk of Rain 2: Hallowed Concepts', edition: 'Digital edition' },
];
const PLATFORMS = [
  { id: 'steam', label: 'Steam' },
  { id: 'epic', label: 'Epic Games Store' },
  { id: 'ps5', label: 'PlayStation 5' },
  { id: 'xbox-series', label: 'Xbox Series X|S' },
  { id: 'switch', label: 'Nintendo Switch' },
];
const REGIONS = [
  { id: 'US', label: 'United States' },
  { id: 'CA', label: 'Canada' },
  { id: 'GB', label: 'United Kingdom' },
  { id: 'DE', label: 'Germany' },
  { id: 'FR', label: 'France' },
  { id: 'AU', label: 'Australia' },
];

// The buy modal moved to the 2K web-platform ids (steam, epic, ps5, ...) with the
// Hallowed Concepts storefront refresh. Retailer routing is still keyed by the
// commerce service's legacy SKU channels, where Steam shipped as "pc-steam".
const RETAILER_STOREFRONTS = {
  'pc-steam': { retailerName: 'Steam', checkoutBaseUrl: 'https://store.steampowered.com/app/632360/Risk_of_Rain_2/', regionParam: 'cc' },
  epic: { retailerName: 'Epic Games', checkoutBaseUrl: 'https://store.epicgames.com/p/risk-of-rain-2', regionParam: 'country' },
  ps5: { retailerName: 'PlayStation', checkoutBaseUrl: 'https://store.playstation.com/search/risk%20of%20rain%202', regionParam: 'country' },
  'xbox-series': { retailerName: 'Xbox', checkoutBaseUrl: 'https://www.xbox.com/games/store/risk-of-rain-2/9mvkpqxl5t26', regionParam: 'market' },
  switch: { retailerName: 'Nintendo', checkoutBaseUrl: 'https://www.nintendo.com/store/products/risk-of-rain-2-switch/', regionParam: 'country' },
};

const REMEDIATION_DIRECTIVE = [
  `Investigate and fix ${TARGET_REPO}. Open a pull request against main; do not merge or deploy.`,
  'Gearbox Entertainment on 2K (/fca13efd): the hero BUY NOW for Risk of Rain 2: Hallowed Concepts returns HTTP 500 when the player keeps the pre-selected Steam platform.',
  'Reproduce: POST /api/fca13efd/buy-now with {"order":{"product":"ror2-hallowed-concepts","platform":"steam","region":"US"}}. Epic Games Store, PlayStation 5, Xbox Series X|S and Nintendo Switch succeed.',
  'Inspect app/services/verticals/fca13efd.js and app/routes/verticals/fca13efd.js.',
  'Find the root cause yourself; the stack trace points at the crash site, not at the cause.',
  'Write a failing regression test in tests/fca13efd-gearbox-buy-now.test.js first, then fix, and update the planted-failure expectation after the fix.',
  'Run `npx jest tests/fca13efd-gearbox-buy-now.test.js` and `npm run lint` and paste the passing output in the PR description.',
  'Keep every platform and region available; do not disable Sentry, swallow errors, remove Steam, or fake a success response.',
].join('\n');

const MAX_STORED_ORDERS = 500;
const orders = new Map();
let lastDevinTriggerAt = 0;

const invalid = message => Object.assign(new Error(message), { name: 'ValidationError', status: 400, code: 'INVALID_BUY_NOW' });
const byId = (list, id) => list.find(item => item.id === id);

function validateOrder(input) {
  if (!input || typeof input !== 'object') throw invalid('Choose a platform and region.');
  if (!byId(PRODUCTS, input.product)) throw invalid('Choose a product.');
  if (!byId(PLATFORMS, input.platform)) throw invalid('Choose a platform.');
  if (!byId(REGIONS, input.region)) throw invalid('Select your region.');
  return { product: input.product, platform: input.platform, region: input.region };
}

function resolveOffer(order) {
  return {
    product: byId(PRODUCTS, order.product),
    platform: order.platform,
    region: order.region,
    storefront: RETAILER_STOREFRONTS[order.platform],
  };
}

function buildRetailerRedirect(offer) {
  const url = new URL(offer.storefront.checkoutBaseUrl);
  url.searchParams.set(offer.storefront.regionParam, offer.region);
  url.searchParams.set('utm_source', '2k.com');
  url.searchParams.set('utm_campaign', 'gearbox-studio-page');
  return { retailerName: offer.storefront.retailerName, redirectUrl: url.toString(), edition: offer.product.edition };
}

function remember(id, record) {
  orders.set(id, record);
  if (orders.size > MAX_STORED_ORDERS) orders.delete(orders.keys().next().value);
}

async function triggerDevinFromSentry(error, { sentryEventId, context, identity = {} }) {
  const config = getCustomerConfig(CUSTOMER);
  if (!config.apiKey) {
    logger.warn('Devin service key not configured — skipping Sentry → Devin session', { service: SERVICE, customer: CUSTOMER });
    return null;
  }
  const now = Date.now();
  if (now - lastDevinTriggerAt < DEVIN_COOLDOWN_MS) {
    logger.info('Sentry → Devin session skipped — cooldown active', { service: SERVICE, sentryEventId });
    return null;
  }
  const capCheck = canCreateSession();
  if (!capCheck.allowed) {
    logger.warn('Sentry → Devin session skipped — global cap reached', { service: SERVICE, current: capCheck.current, max: capCheck.max });
    return null;
  }
  lastDevinTriggerAt = now;
  const releaseSlot = reserveSession();
  const tags = { route: ROUTE, service: SERVICE, customer: CUSTOMER, sentry_event_id: sentryEventId || 'unknown' };
  const prompt = buildPrompt({
    issueTitle: `${error.name}: ${error.message}`,
    culprit: CULPRIT, errorType: error.name, errorValue: error.message,
    customer: CUSTOMER, customerConfig: config, service: SERVICE,
    verticalLabel: config.label, level: 'error', platform: 'node',
    tags: Object.entries(tags).map(([key, value]) => ({ key, value })), extra: context,
    promptAppendix: REMEDIATION_DIRECTIVE,
  });
  logger.info('Sentry issue captured — triggering Devin session (no Slack)', { service: SERVICE, sentryEventId, orderId: context.orderId });
  try {
    const session = await createDevinSession(prompt, {
      apiKey: config.apiKey,
      userId: identity.devinUserId || config.devinUserId,
      orgId: identity.devinOrgId || config.devinOrgId,
      title: `Sentry: ${error.name} in ${SERVICE}`,
      repos: [TARGET_REPO],
    });
    logger.info('Devin session created from Sentry issue', { service: SERVICE, sessionId: session && session.sessionId, url: session && session.url });
    return session;
  } catch (err) {
    releaseSlot();
    lastDevinTriggerAt = 0;
    logger.error('Failed to create Devin session from Sentry issue', { service: SERVICE, error: err.message });
    return null;
  }
}

async function submitBuyNow(data = {}, now = new Date()) {
  const order = validateOrder(data.order);
  let orderId;
  do orderId = `2K-BN-${now.getUTCFullYear()}-${String(crypto.randomInt(0, 1e6)).padStart(6, '0')}`; while (orders.has(orderId));
  try {
    const offer = resolveOffer(order);
    const redirect = buildRetailerRedirect(offer);
    remember(orderId, { order, redirect, at: now.toISOString() });
    logger.info('Gearbox BUY NOW routed to retailer', { service: SERVICE, orderId, ...order, retailer: redirect.retailerName });
    return {
      success: true, orderId, product: offer.product.label,
      platform: byId(PLATFORMS, order.platform).label, region: byId(REGIONS, order.region).label, ...redirect,
    };
  } catch (error) {
    const context = { orderId, ...order };
    const sentryEventId = Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: 'instant' },
      extra: context,
    });
    logger.error('Gearbox BUY NOW failed', { ...context, service: SERVICE, error: error.message });
    triggerDevinFromSentry(error, {
      sentryEventId, context,
      identity: { devinUserId: data.devinUserId, devinOrgId: data.devinOrgId },
    }).catch(err => logger.error('Sentry → Devin trigger failed', { service: SERVICE, error: err.message }));
    throw Object.assign(error, { status: 500, code: 'BUY_NOW_FAILED', requestId: orderId });
  }
}

function resetDevinCooldown() {
  lastDevinTriggerAt = 0;
}

module.exports = {
  CUSTOMER, SERVICE, ROUTE, CULPRIT, TARGET_REPO, PRODUCTS, PLATFORMS, REGIONS, REMEDIATION_DIRECTIVE,
  validateOrder, resolveOffer, buildRetailerRedirect, submitBuyNow, triggerDevinFromSentry, resetDevinCooldown,
};
