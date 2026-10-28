const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { getCustomerConfig } = require('../../../config/customers');
const { createSessionAndAlert } = require('../devin-session');
const { declareDatadogIncident } = require('../datadog-incidents');
const { createLinearIssue, addLinearComment } = require('../linear');
const { postLinearIssueLink } = require('../slack');

const SLUG = '74f7816c';
const SERVICE = `customer-${SLUG}-freestyle-checkout`;
const ROUTE = `/api/${SLUG}/checkout`;
const HOLD_TTL_MS = 15 * 60 * 1000;
const LOW_STOCK_THRESHOLD = 2;
const LINEAR_TEAM_ID = process.env.LINEAR_TEAM_ID_74F7816C
  || process.env.LINEAR_TEAM_ID_B25C3F24
  || '3c9f0e1e-54da-442d-8949-a62489060822';
const LINEAR_ASSIGNEE_ID = process.env.LINEAR_ASSIGNEE_ID_74F7816C
  || process.env.LINEAR_ASSIGNEE_ID_B25C3F24
  || '4d616028-0c12-4ad9-b117-0661170e857e';
const LINEAR_STATE_IN_PROGRESS_ID = process.env.LINEAR_STATE_IN_PROGRESS_74F7816C
  || process.env.LINEAR_STATE_IN_PROGRESS_B25C3F24
  || '99c9b96f-39b3-4a09-9112-53c054f3dbab';
const LINEAR_STATE_IN_REVIEW_ID = process.env.LINEAR_STATE_IN_REVIEW_74F7816C
  || process.env.LINEAR_STATE_IN_REVIEW_B25C3F24
  || 'd79ea314-a400-4382-9140-d4861fb4e30f';

const CLIENT = { firstName: 'Vanessa', sizes: { top: 'M', bottom: '8', shoes: '8', accessory: 'One size' } };

const PRODUCTS = {
  'MS-4471': { brand: 'Market & Spruce', name: 'Arlo Zip Hoodie', color: 'Evergreen', category: 'top', priceCents: 5800, art: 'hoodie' },
  'KL-2208': { brand: 'Kaileigh', name: 'Sunset Tie-Dye Tee', color: 'Coral multi', category: 'top', priceCents: 3400, art: 'tee' },
  'DR-9013': { brand: 'Daniel Rainn', name: 'Easy Knit Jogger', color: 'Oat', category: 'bottom', priceCents: 6800, art: 'jogger' },
  'LV-3150': { brand: 'Liverpool', name: 'Quilted Mini Backpack', color: 'Navy', category: 'accessory', priceCents: 7800, art: 'backpack' },
  'TB-6402': { brand: 'Treasure & Bond', name: 'Court Sneaker', color: 'White', category: 'shoes', priceCents: 8900, art: 'sneaker' },
  'FH-1187': { brand: '41Hawthorn', name: 'Marlow Striped Sweater', color: 'Rust stripe', category: 'top', priceCents: 6400, art: 'sweater' },
  'JB-5520': { brand: 'Just Black Denim', name: 'Straight Leg Trouser', color: 'Black', category: 'bottom', priceCents: 7800, art: 'pants' },
  'KL-7731': { brand: 'Kaileigh', name: 'Suede Ballet Flat', color: 'Camel', category: 'shoes', priceCents: 7200, art: 'flats' },
  'PM-0846': { brand: 'Papermoon', name: 'Beaded Drop Earrings', color: 'Mint', category: 'accessory', priceCents: 2800, art: 'earrings' },
  'PX-3374': { brand: 'Pixley', name: 'Cropped Cardigan', color: 'Heather grey', category: 'top', priceCents: 5400, art: 'cardigan' },
  'MV-2219': { brand: 'Mavi', name: 'Barcelona Mom Jean', color: 'Light indigo', category: 'bottom', priceCents: 9800, art: 'jeans' },
  'FT-6630': { brand: 'Fate', name: 'Leather Crossbody', color: 'Tan', category: 'accessory', priceCents: 6800, art: 'bag' },
};

const LOOKS = [
  {
    id: 'look-weekend-errands',
    name: 'Weekend errands',
    rail: 'trending',
    note: 'Cozy layers for a Saturday farmers market run.',
    skus: ['MS-4471', 'KL-2208', 'DR-9013', 'LV-3150', 'TB-6402'],
  },
  {
    id: 'look-desk-to-dinner',
    name: 'Desk to dinner',
    rail: 'trending',
    note: 'Polished stripes that work from the office to the table.',
    skus: ['FH-1187', 'JB-5520', 'KL-7731', 'PM-0846'],
  },
  {
    id: 'look-fall-weekend',
    name: 'Fall weekend',
    rail: 'complete',
    note: 'Finish the jeans you kept from your last Fix.',
    skus: ['PX-3374', 'MV-2219', 'FT-6630'],
  },
];

// Fulfillment-center stock by SKU and size: on hand, minus units already
// committed to placed orders being picked.
const INVENTORY = {
  'MS-4471:M': { onHand: 4, committed: 2 },
  'MS-4471:L': { onHand: 1, committed: 1 },
  'KL-2208:M': { onHand: 18, committed: 3 },
  'DR-9013:8': { onHand: 12, committed: 1 },
  'LV-3150:One size': { onHand: 25, committed: 4 },
  'TB-6402:8': { onHand: 9, committed: 2 },
  'FH-1187:M': { onHand: 14, committed: 2 },
  'JB-5520:8': { onHand: 11, committed: 0 },
  'KL-7731:8': { onHand: 7, committed: 1 },
  'PM-0846:One size': { onHand: 30, committed: 5 },
  'PX-3374:M': { onHand: 10, committed: 1 },
  'MV-2219:8': { onHand: 16, committed: 2 },
  'FT-6630:One size': { onHand: 8, committed: 0 },
};

// Bag holds currently open for other shoppers' carts.
const ACTIVE_HOLDS = [
  { holdId: 'hold-7c21', cartId: 'cart-other-1', sku: 'MS-4471', size: 'M', quantity: 1 },
  { holdId: 'hold-9e04', cartId: 'cart-other-2', sku: 'KL-2208', size: 'M', quantity: 2 },
  { holdId: 'hold-31aa', cartId: 'cart-other-3', sku: 'TB-6402', size: '8', quantity: 1 },
];

const REMEDIATION_DIRECTIVE = [
  '!freestyle_checkout_triage',
  '',
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Stitch Fix Freestyle bag checkout:',
  `- Service: \`app/services/verticals/${SLUG}.js\``,
  `- Route: \`app/routes/verticals/${SLUG}.js\``,
  `- Page: \`app/public/verticals/${SLUG}.html\` (served at \`/stitchfix\`)`,
  '',
  'Before changing code, pull the runtime evidence through your MCP integrations:',
  `- Sentry MCP: find the latest \`ItemUnavailableError\` issue for service \`${SERVICE}\` and read its stack trace and tags (\`look\`, \`unavailable_skus\`).`,
  '- Datadog MCP: query `demo.stitchfix_freestyle.checkout_failure` and `_success` by `look` and the SEV-2 incident "Stitch Fix Freestyle checkout rejecting items just added to bag".',
  `Fix the root cause in the availability check (not the error message or the page), add regression coverage in \`tests/${SLUG}-freestyle-checkout.test.js\`, and resolve the Datadog incident in the PR description.`,
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function buildRemediationDirective(issue) {
  if (!issue) return REMEDIATION_DIRECTIVE;

  return [
    REMEDIATION_DIRECTIVE,
    '',
    `*Linear ticket:* ${issue.identifier} — ${issue.url}`,
    'The ticket is created in In Progress, and the app comments your session link on it and posts the ticket link in the Slack alert thread. If the ticket is not In Progress or your session link is missing, do only that missing update yourself first.',
    `- As soon as your PR is open: comment on the ticket with the PR URL (Linear MCP \`create_comment\` / or the GraphQL API with \`LINEAR_API_KEY\`), add the PR link to the ticket, and move the ticket to the "In Review" state (id '${LINEAR_STATE_IN_REVIEW_ID}').`,
    '- Do NOT move the ticket to Done. The reviewer moves it to Done after approving and merging the PR.',
    '- If you push follow-up commits after review feedback, leave the ticket In Review and add a short comment.',
  ].join('\n');
}

function httpError(name, message, code, statusCode) {
  const error = new Error(message);
  error.name = name;
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function stockFor(sku, size) {
  return INVENTORY[`${sku}:${size}`] || { onHand: 0, committed: 0 };
}

/**
 * Units of a SKU/size that can still be promised: on hand, minus units
 * committed to placed orders, minus open bag holds. Pass excludeCartId to
 * ignore the holds that cart already owns.
 */
function availableToPromise(sku, size, holds, { excludeCartId } = {}) {
  const { onHand, committed } = stockFor(sku, size);
  const held = holds
    .filter((hold) => hold.sku === sku && hold.size === size && hold.cartId !== excludeCartId)
    .reduce((sum, hold) => sum + hold.quantity, 0);
  return onHand - committed - held;
}

function describeItem(sku, size) {
  const product = PRODUCTS[sku];
  return { sku, size, ...product };
}

function listLooks() {
  return {
    client: CLIENT,
    looks: LOOKS.map((look) => ({
      ...look,
      items: look.skus.map((sku) => {
        const item = describeItem(sku, CLIENT.sizes[PRODUCTS[sku].category]);
        const available = availableToPromise(sku, item.size, ACTIVE_HOLDS);
        return { ...item, available, lowStock: available > 0 && available <= LOW_STOCK_THRESHOLD };
      }),
    })),
  };
}

function addLookToBag(data = {}) {
  const look = LOOKS.find((candidate) => candidate.id === data.lookId);
  if (!look) throw httpError('ValidationError', `Unknown look: ${data.lookId || '(none)'}`, 'UNKNOWN_LOOK', 400);
  const cartId = typeof data.cartId === 'string' && data.cartId ? data.cartId : `cart-${uuidv4()}`;
  const expiresAt = new Date(Date.now() + HOLD_TTL_MS).toISOString();

  const lines = look.skus.map((sku) => {
    const size = CLIENT.sizes[PRODUCTS[sku].category];
    if (availableToPromise(sku, size, ACTIVE_HOLDS) < 1) {
      throw httpError('ItemUnavailableError', `${PRODUCTS[sku].name} (${size}) is sold out`, 'ITEM_SOLD_OUT', 409);
    }
    return {
      ...describeItem(sku, size),
      lookId: look.id,
      quantity: 1,
      holdId: `hold-${uuidv4().slice(0, 8)}`,
      expiresAt,
    };
  });

  return { success: true, cartId, lookId: look.id, lines };
}

function normalizeLines(lines) {
  if (!Array.isArray(lines) || lines.length === 0) {
    throw httpError('ValidationError', 'Your bag is empty.', 'EMPTY_BAG', 400);
  }
  return lines.map((line) => {
    if (!line || !PRODUCTS[line.sku] || !INVENTORY[`${line.sku}:${line.size}`]) {
      throw httpError('ValidationError', `Unknown item: ${line && line.sku}`, 'UNKNOWN_ITEM', 400);
    }
    return {
      sku: line.sku,
      size: line.size,
      quantity: Math.min(Math.max(parseInt(line.quantity, 10) || 1, 1), 5),
      holdId: line.holdId,
      lookId: line.lookId,
    };
  });
}

function buildHoldLedger(cartId, lines) {
  const cartHolds = lines
    .filter((line) => line.holdId)
    .map((line) => ({ holdId: line.holdId, cartId, sku: line.sku, size: line.size, quantity: line.quantity }));
  return [...ACTIVE_HOLDS, ...cartHolds];
}

function reserveBag(cartId, lines) {
  const ledger = buildHoldLedger(cartId, lines);
  const unavailable = lines
    .filter((line) => availableToPromise(line.sku, line.size, ledger) < line.quantity)
    .map((line) => describeItem(line.sku, line.size));
  if (unavailable.length > 0) {
    const [first] = unavailable;
    const error = httpError(
      'ItemUnavailableError',
      `${first.name} (${first.color}, ${first.size}) is no longer available`,
      'ITEM_UNAVAILABLE',
      409,
    );
    error.unavailable = unavailable;
    throw error;
  }
}

async function checkout(data = {}) {
  if (typeof data.cartId !== 'string' || !data.cartId) {
    throw httpError('ValidationError', 'Missing cart.', 'MISSING_CART', 400);
  }
  const { cartId } = data;
  const lines = normalizeLines(data.lines);
  const lookIds = [...new Set(lines.map((line) => line.lookId).filter(Boolean))];
  const runRef = uuidv4();
  const startTime = Date.now();
  const metricTags = { look: lookIds.join(',') || 'none', item_count: String(lines.length) };

  try {
    reserveBag(cartId, lines);
    const subtotalCents = lines.reduce((sum, line) => sum + PRODUCTS[line.sku].priceCents * line.quantity, 0);
    const duration = Date.now() - startTime;
    incrementMetric('stitchfix_freestyle.checkout_success', metricTags);
    recordTiming('stitchfix_freestyle.checkout_latency', duration, { ...metricTags, error: 'false' });
    return {
      success: true,
      orderId: `SF-${runRef.slice(0, 8).toUpperCase()}`,
      cartId,
      subtotalCents,
      shippingCents: 0,
      totalCents: subtotalCents,
      arrives: 'Fri, Nov 6',
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    const unavailableSkus = (error.unavailable || []).map((item) => `${item.sku}:${item.size}`);
    incrementMetric('stitchfix_freestyle.checkout_failure', { ...metricTags, errorClass: error.name });
    recordTiming('stitchfix_freestyle.checkout_latency', duration, { ...metricTags, error: 'true' });
    logger.error('Stitch Fix Freestyle checkout failed', {
      runRef,
      cartId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      lookIds,
      unavailableSkus,
      service: SERVICE,
      route: ROUTE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        look: metricTags.look,
        unavailable_skus: unavailableSkus.join(','),
        alert_path: 'instant',
      },
      extra: { runRef, cartId, lines },
    });

    declareDatadogIncident({
      title: 'Stitch Fix Freestyle checkout rejecting items just added to bag',
      summary: `${error.name}: ${error.message}. Clients add a Stylist look to their bag and checkout says an item is no longer available.`,
      runRef,
      service: SERVICE,
      triggeredBy: data.devinEmail || 'freestyle-checkout',
      repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
      severity: 'SEV-2',
    }).catch((err) => logger.warn('Failed to declare Datadog incident for Freestyle checkout', {
      error: err.message,
      runRef,
    }));

    (async () => {
      let issue = null;
      try {
        issue = await createLinearIssue({
          title: `[Stitch Fix Freestyle] ${error.name}: ${error.message}`,
          description: [
            'Clients add a Stylist look to their Freestyle bag, then checkout rejects it saying an item is no longer available.',
            '',
            `- Service: \`${SERVICE}\``,
            `- Route: \`POST ${ROUTE}\``,
            `- Look: \`${metricTags.look}\``,
            `- Unavailable: \`${unavailableSkus.join(', ') || 'n/a'}\``,
            `- Checkout ref: \`${runRef}\``,
            `- Error: \`${error.name}: ${error.message}\``,
            '',
            `Repository: https://github.com/COG-GTM/event-driven-devin (\`app/services/verticals/${SLUG}.js\`).`,
            'Sentry has the stack trace for this service; Datadog has a SEV-2 incident "Stitch Fix Freestyle checkout rejecting items just added to bag".',
            '',
            'Triage with the `!freestyle_checkout_triage` playbook.',
          ].join('\n'),
          teamId: LINEAR_TEAM_ID,
          assigneeId: LINEAR_ASSIGNEE_ID,
          priority: 2,
          stateId: LINEAR_STATE_IN_PROGRESS_ID,
        });
      } catch (err) {
        logger.warn('Failed to create Linear issue for Freestyle checkout', { error: err.message, runRef });
      }

      const outcome = await createSessionAndAlert({
        issueTitle: `${error.name}: ${error.message}`,
        issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
        culprit: `app/services/verticals/${SLUG}.js — reserveBag`,
        errorType: error.name || 'Error',
        errorValue: error.message,
        devinUserId: data.devinUserId,
        devinEmail: data.devinEmail,
        devinOrgId: data.devinOrgId,
        service: SERVICE,
        verticalLabel: 'Stitch Fix Freestyle — Bag Checkout',
        promptAppendix: buildRemediationDirective(issue),
        customer: SLUG,
        tags: [
          { key: 'route', value: ROUTE },
          { key: 'service', value: SERVICE },
          { key: 'look', value: metricTags.look },
          { key: 'unavailable_skus', value: unavailableSkus.join(',') },
        ],
        extra: { runRef, cartId, lookIds, unavailableSkus },
        level: 'error',
        platform: 'node',
        firstSeen: '',
        lastSeen: new Date().toISOString(),
        count: '',
        shortId: '',
        project: 'event-driven-devin',
        release: process.env.SENTRY_RELEASE || `${SERVICE}@1.0.0`,
        environment: process.env.DD_ENV || 'prod',
        triggeredRule: '',
      });

      if (issue && outcome && outcome.threadTs) {
        try {
          await postLinearIssueLink(outcome.threadTs, issue, getCustomerConfig(SLUG).slackChannelId || undefined);
        } catch (err) {
          logger.warn('Failed to post Linear issue link to Slack alert thread', {
            error: err.message,
            identifier: issue.identifier,
            runRef,
          });
        }
      }

      if (issue && outcome && outcome.session) {
        const session = outcome.session;
        const commented = await addLinearComment({
          issueId: issue.id,
          body: [
            `Devin picked this up: ${session.url}`,
            '',
            'The PR link will be posted here and the ticket moved to **In Review** once the fix is ready.',
          ].join('\n'),
        })
          .then(() => true)
          .catch((err) => {
            logger.warn('Failed to comment Devin session on Linear issue', {
              error: err.message,
              identifier: issue.identifier,
              runRef,
            });
            return false;
          });
        logger.info('Linear issue linked to Devin session', {
          identifier: issue.identifier,
          sessionId: session.sessionId,
          runRef,
          commented,
        });
      }
    })().catch((err) => logger.warn('Freestyle checkout incident follow-up failed', { error: err.message, runRef }));

    throw error;
  }
}

module.exports = {
  CLIENT,
  PRODUCTS,
  LOOKS,
  INVENTORY,
  ACTIVE_HOLDS,
  availableToPromise,
  listLooks,
  addLookToBag,
  checkout,
  REMEDIATION_DIRECTIVE,
  buildRemediationDirective,
  LINEAR_STATE_IN_PROGRESS_ID,
  LINEAR_STATE_IN_REVIEW_ID,
};
