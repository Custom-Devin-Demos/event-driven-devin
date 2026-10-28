const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-0875ddd9-2k-store-checkout';
const ROUTE = '/api/0875ddd9/checkout';
const ORDER_PREFIX = '2KS';

const PLATFORMS = {
  ps5: { label: 'PlayStation 5', storefront: 'PlayStation Store' },
  'xbox-series': { label: 'Xbox Series X|S', storefront: 'Microsoft Store' },
  steam: { label: 'PC (Steam)', storefront: 'Steam' },
  'switch-2': { label: 'Nintendo Switch 2', storefront: 'Nintendo eShop' },
};

const TITLES = {
  'nba-2k27': {
    label: 'NBA 2K27',
    franchise: 'nba-2k',
    editions: {
      standard: { label: 'Standard Edition', priceCents: 6999 },
      deluxe: { label: 'Deluxe Edition', priceCents: 9999 },
      ultra: { label: 'Ultra Edition', priceCents: 14999 },
    },
  },
  'wwe-2k26': {
    label: 'WWE 2K26',
    franchise: 'wwe-2k',
    editions: {
      standard: { label: 'Standard Edition', priceCents: 6999 },
      deluxe: { label: 'Deluxe Edition', priceCents: 9999 },
    },
  },
  'borderlands-4': {
    label: 'Borderlands 4',
    franchise: 'borderlands',
    editions: {
      standard: { label: 'Standard Edition', priceCents: 6999 },
      deluxe: { label: 'Deluxe Edition', priceCents: 9999 },
    },
  },
  'mafia-the-old-country': {
    label: 'Mafia: The Old Country',
    franchise: 'mafia',
    editions: {
      standard: { label: 'Standard Edition', priceCents: 4999 },
    },
  },
  'civilization-vii': {
    label: 'Sid Meier\u2019s Civilization VII',
    franchise: 'civilization',
    editions: {
      standard: { label: 'Standard Edition', priceCents: 6999 },
      deluxe: { label: 'Deluxe Edition', priceCents: 9999 },
    },
  },
};

/**
 * Entitlement catalog published by each franchise's live-ops team to 2K
 * Account (DNA) — what actually gets granted to the player's linked account
 * after the platform purchase clears.
 */
const ENTITLEMENT_CATALOG = {
  'nba2k27-base-game': { label: 'NBA 2K27 base game', vcAmount: 0, grantService: 'dna-entitlements' },
  'nba2k27-vc-15000': { label: '15,000 Virtual Currency', vcAmount: 15000, grantService: 'nba-vc-ledger' },
  'nba2k27-vc-100000': { label: '100,000 Virtual Currency', vcAmount: 100000, grantService: 'nba-vc-ledger' },
  'nba2k27-myteam-packs': { label: 'MyTEAM content bundle', vcAmount: 0, grantService: 'myteam-inventory' },
  'nba2k27-myplayer-boosts': { label: 'MyPLAYER skill boosts', vcAmount: 0, grantService: 'dna-entitlements' },
  'wwe2k26-base-game': { label: 'WWE 2K26 base game', vcAmount: 0, grantService: 'dna-entitlements' },
  'wwe2k26-season-pass': { label: 'WWE 2K26 Season Pass', vcAmount: 0, grantService: 'dna-entitlements' },
  'wwe2k26-vc-12500': { label: '12,500 Virtual Currency', vcAmount: 12500, grantService: 'wwe-vc-ledger' },
  'bl4-base-game': { label: 'Borderlands 4 base game', vcAmount: 0, grantService: 'shift-entitlements' },
  'bl4-bounty-pack-bundle': { label: 'Bounty Pack bundle', vcAmount: 0, grantService: 'shift-entitlements' },
  'mtoc-base-game': { label: 'Mafia: The Old Country base game', vcAmount: 0, grantService: 'dna-entitlements' },
  'civ7-base-game': { label: 'Civilization VII base game', vcAmount: 0, grantService: 'dna-entitlements' },
  'civ7-founders-content': { label: 'Founders content pack', vcAmount: 0, grantService: 'dna-entitlements' },
};

/**
 * What each storefront SKU grants. Owned by 2K Store merchandising.
 *
 * The NBA 2K27 Season 2 "Locker Code" launch-window bonus was attached to the
 * Standard Edition SKU by merchandising for the Season 2 drop. The matching
 * entitlement is published to ENTITLEMENT_CATALOG by NBA 2K live-ops on their
 * own release train, which ships after the Season 2 storefront update.
 */
const EDITION_ENTITLEMENTS = {
  'nba-2k27:standard': ['nba2k27-base-game', 'nba2k27-vc-15000', 'nba2k27-s2-locker-code-vc'],
  'nba-2k27:deluxe': ['nba2k27-base-game', 'nba2k27-vc-15000', 'nba2k27-myteam-packs', 'nba2k27-myplayer-boosts'],
  'nba-2k27:ultra': ['nba2k27-base-game', 'nba2k27-vc-100000', 'nba2k27-myteam-packs', 'nba2k27-myplayer-boosts'],
  'wwe-2k26:standard': ['wwe2k26-base-game'],
  'wwe-2k26:deluxe': ['wwe2k26-base-game', 'wwe2k26-season-pass', 'wwe2k26-vc-12500'],
  'borderlands-4:standard': ['bl4-base-game'],
  'borderlands-4:deluxe': ['bl4-base-game', 'bl4-bounty-pack-bundle'],
  'mafia-the-old-country:standard': ['mtoc-base-game'],
  'civilization-vii:standard': ['civ7-base-game'],
  'civilization-vii:deluxe': ['civ7-base-game', 'civ7-founders-content'],
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the 2K Store checkout (BUY NOW) vertical:',
  '- Service: `app/services/verticals/0875ddd9.js`',
  '- Route: `app/routes/verticals/0875ddd9.js`',
  '- Page: `app/public/verticals/0875ddd9.html` (served at `/0875ddd9`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.statusCode = 400;
  error.code = code;
  return error;
}

function validateCheckoutRequest(order) {
  const title = TITLES[order.title];
  if (!title) throw validationError('Choose a game to buy.', 'UNKNOWN_TITLE');
  if (!title.editions[order.edition]) throw validationError(`${title.label} is not sold in that edition.`, 'UNKNOWN_EDITION');
  if (!PLATFORMS[order.platform]) throw validationError('Choose a platform.', 'UNKNOWN_PLATFORM');
  if (!EMAIL_RE.test(order.email)) throw validationError('Enter the email address on your 2K Account.', 'INVALID_EMAIL');
}

function resolveEntitlements(titleKey, editionKey) {
  const skus = EDITION_ENTITLEMENTS[`${titleKey}:${editionKey}`] || [];
  return skus.map((sku) => ENTITLEMENT_CATALOG[sku]);
}

/**
 * Splits an order's entitlements into per-service grant batches and totals the
 * Virtual Currency credited to the player's 2K Account ledger.
 */
function buildFulfillmentPlan(entitlements, platform) {
  const grants = {};
  let vcGranted = 0;
  for (const entitlement of entitlements) {
    vcGranted += entitlement.vcAmount;
    (grants[entitlement.grantService] = grants[entitlement.grantService] || []).push(entitlement.label);
  }
  return {
    vcGranted,
    grants,
    deliveredVia: PLATFORMS[platform].storefront,
  };
}

async function placeOrder(data = {}) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const order = {
    title: String(data.title ?? '').trim().toLowerCase(),
    edition: String(data.edition ?? '').trim().toLowerCase(),
    platform: String(data.platform ?? '').trim().toLowerCase(),
    email: String(data.email ?? '').trim(),
    devinUserId: data.devinUserId,
    devinOrgId: data.devinOrgId,
    devinEmail: data.devinEmail,
  };

  validateCheckoutRequest(order);

  logger.info('Processing 2K Store checkout', {
    requestId,
    title: order.title,
    edition: order.edition,
    platform: order.platform,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const title = TITLES[order.title];
    const edition = title.editions[order.edition];
    const entitlements = resolveEntitlements(order.title, order.edition);
    const plan = buildFulfillmentPlan(entitlements, order.platform);
    const orderId = `${ORDER_PREFIX}-${uuidv4().slice(0, 8).toUpperCase()}`;
    const duration = Date.now() - startTime;

    incrementMetric('store.checkout_completed', {
      route: ROUTE,
      title: order.title,
      edition: order.edition,
      platform: order.platform,
    });
    recordTiming('store.checkout_latency', duration, { route: ROUTE });

    return {
      success: true,
      orderId,
      title: title.label,
      edition: edition.label,
      platform: PLATFORMS[order.platform].label,
      totalCents: edition.priceCents,
      currency: 'USD',
      entitlements: entitlements.map((e) => e.label),
      vcGranted: plan.vcGranted,
      deliveredVia: plan.deliveredVia,
      message: `Your ${title.label} ${edition.label} is linked to your 2K Account. Download it from ${plan.deliveredVia}.`,
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('store.checkout_failure', {
      route: ROUTE,
      errorClass: error.name,
      title: order.title,
      edition: order.edition,
    });
    recordTiming('store.checkout_latency', duration, { route: ROUTE, error: 'true' });

    logger.error('2K Store checkout fulfillment failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      title: order.title,
      edition: order.edition,
      platform: order.platform,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        title: order.title,
        edition: order.edition,
        platform: order.platform,
        alert_path: 'instant',
      },
      extra: {
        requestId,
        title: order.title,
        edition: order.edition,
        platform: order.platform,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/0875ddd9.js \u2014 buildFulfillmentPlan',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: order.devinUserId,
      devinEmail: order.devinEmail,
      devinOrgId: order.devinOrgId,
      service: SERVICE,
      verticalLabel: '2K Store Checkout',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '0875ddd9',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'title', value: order.title },
        { key: 'edition', value: order.edition },
        { key: 'platform', value: order.platform },
        { key: 'order_prefix', value: ORDER_PREFIX },
      ],
      extra: {
        requestId,
        title: order.title,
        edition: order.edition,
        platform: order.platform,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || `${SERVICE}@27.2.0`,
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for 2K Store checkout error', {
        error: alertError.message,
        requestId,
      });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  placeOrder,
  resolveEntitlements,
  buildFulfillmentPlan,
  TITLES,
  PLATFORMS,
  ENTITLEMENT_CATALOG,
  EDITION_ENTITLEMENTS,
  SERVICE,
  ROUTE,
  ORDER_PREFIX,
  REMEDIATION_DIRECTIVE,
};
