const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const ROUTE = '/api/2b43150a/checkout';
const SERVICE = 'customer-gap-pdp-checkout';
// The JSON log line carries this service in its own `service` attribute; the reserved
// service tag stays the agent-level checkout-api, so the query uses the attribute.
const DATADOG_LOGS_QUERY = `@service:${SERVICE} status:error`;

const IMAGE_BASE = 'https://content.gapinc.com/b/0063/336/';

const PRODUCT = {
  styleNumber: '907280',
  name: 'Relaxed Polo Sweater',
  department: 'Men',
  category: 'Sweaters',
  price: 79.95,
  rating: 5,
  ratingCount: 1,
  promoLine: '40% off at checkout',
  fits: ['Regular', 'Tall'],
  sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL'],
  images: [
    `${IMAGE_BASE}073/cn63336073.png?width=737`,
    `${IMAGE_BASE}080/cn63336080.png?width=737`,
    `${IMAGE_BASE}085/cn63336085.png?width=737`,
    `${IMAGE_BASE}102/cn63336102.png?width=737`,
    `${IMAGE_BASE}044/cn63336044.png?width=737`,
  ],
  details: [
    'Soft knit cotton polo sweater. In a relaxed fit.',
    'Spread collar with front button placket.',
    'Long sleeves with drop shoulders.',
    'Ribbed cuffs and hem.',
    'Product #907280',
  ],
  colors: [
    { variantId: '907280002', name: 'Terra brown', swatch: '#3b2416' },
    { variantId: '907280012', name: 'New classic navy blue', swatch: '#0f1a3a', isNew: true, droppedOn: '2026-10-09' },
    { variantId: '907280022', name: 'Blue & grey stripe', swatch: 'repeating-linear-gradient(180deg, #3d4a63 0 3px, #8e949c 3px 6px)' },
    { variantId: '907280032', name: 'Bamboo green stripe', swatch: 'repeating-linear-gradient(180deg, #2f4a3b 0 3px, #6f8d7a 3px 6px)' },
    { variantId: '907280042', name: 'True black', swatch: '#111111' },
    { variantId: '907280052', name: 'Regular gray', swatch: '#c9c9c9' },
  ],
};

/**
 * Friends & Family event. The PDP advertises the discount as "40% off at
 * checkout": the storefront shows full price and the bag applies the markdown
 * when the shopper checks out.
 */
const FRIENDS_AND_FAMILY = {
  code: 'FAMILY',
  label: 'Friends & Family 40% off everything',
  endsOn: '2026-10-21',
};

/**
 * Checkout markdowns, keyed by style-color variant. Merchandising publishes one
 * entry per colorway in the event; checkout prices each bag line from its
 * variant's entry (discount rate and whether the line is excluded).
 */
const CHECKOUT_MARKDOWNS = {
  907280002: { rate: 0.40, excluded: false, event: FRIENDS_AND_FAMILY.code },
  907280022: { rate: 0.40, excluded: false, event: FRIENDS_AND_FAMILY.code },
  907280032: { rate: 0.40, excluded: false, event: FRIENDS_AND_FAMILY.code },
  907280042: { rate: 0.40, excluded: false, event: FRIENDS_AND_FAMILY.code },
  907280052: { rate: 0.40, excluded: false, event: FRIENDS_AND_FAMILY.code },
};

const SALES_TAX_RATE = 0.08875;
const FREE_SHIPPING_THRESHOLD = 50;
const STANDARD_SHIPPING = 7;

const GAP_SLACK_MEMBER_ID = process.env.GAP_PDP_SLACK_MEMBER_ID || '';
const GAP_DEVIN_USER_ID = process.env.DEVIN_USER_ID_2B43150A || '';

const SENTRY_ISSUE_QUERY = 'is:unresolved rate';

function datadogLogsUrl() {
  const site = process.env.DD_SITE || 'datadoghq.com';
  const host = site === 'datadoghq.com' ? 'app.datadoghq.com' : site;
  return `https://${host}/logs?query=${encodeURIComponent(DATADOG_LOGS_QUERY)}`;
}

const REMEDIATION_DIRECTIVE = `Repository: COG-GTM/event-driven-devin. Scope: only the Gap product page checkout failure below. This repository hosts many independent demo verticals, each with its own intentional bug and its own Sentry issues (for example POST /api/banking/transfer, POST /api/storefront/checkout and the other Gap verticals under /api/43f2f084, /api/f813dd7a and /api/383b99d1 throw their own TypeErrors and generate constant background traffic). Ignore every issue that is not from POST ${ROUTE}, do not investigate or modify any other vertical, and do not widen the Sentry or Datadog search beyond this route. The failing surface is the Relaxed Polo Sweater product page at app/public/verticals/2b43150a.html (served at /2b43150a), where "Add to Bag" opens the bag and the bag's "Checkout" button posts to POST ${ROUTE} in app/routes/verticals/2b43150a.js. The checkout pipeline lives in app/services/verticals/2b43150a.js: placeOrder -> priceBag -> applyCheckoutMarkdown -> markdownLine. Start at applyCheckoutMarkdown: it looks up CHECKOUT_MARKDOWNS by the bag line's style-color variant, and the new colorway 907280012 (New classic navy blue, dropped 2026-10-09) was added to the product without a Friends & Family markdown entry, so markdownLine dereferences undefined. Add the missing variant's markdown entry (the same 40% Friends & Family values as the other colorways), and make a variant without a markdown entry fail as a handled "This item's promotion isn't available right now" error (HTTP 409, no alert) instead of a TypeError. Do not change the page's look and feel and do not touch other verticals. The Datadog logs for this failure are the error logs with service ${SERVICE} (Logs query: ${DATADOG_LOGS_QUERY}); each one carries the requestId, variantId, size and durationMs of the failed checkout, and the alert's "View Datadog" button opens that query. Verify by starting the server (node app/server.js) and POSTing {"variantId":"907280012","size":"M","fit":"Regular","quantity":1} to ${ROUTE}, which must return an order whose pricing applies the 40% markdown (merchandise 79.95, markdown -31.98), and confirm npm run lint passes.

Reproduce before you diagnose. Your first action after reading the alert, before reading any source file and before proposing a cause, is to start the server (node app/server.js), open /2b43150a?repro=1 in a real browser, pick a size, click "Add to Bag", then click "Checkout" in the bag, with your screen recording, so the recording shows the product page, the bag, the click and the checkout error. Always use ?repro=1 for your own submissions: the checkout fails identically but raises no Sentry event, Slack alert or Devin session. If it does not reproduce, stop and report that instead of fixing anything.

Verification evidence is mandatory and must be visual, not curl-only: after the fix, repeat the same /2b43150a?repro=1 browser flow with a second screen recording showing the order confirmation with the Friends & Family markdown applied where the error used to be. Attach both recordings (as animated webp) under "Reproduction" and "Fix Verification" headings to the pull request.`;

function validationError(message, code = 'INVALID_CHECKOUT') {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function round(amount) {
  return Math.round(amount * 100) / 100;
}

function markdownLine(line, markdown) {
  const rate = markdown.rate;
  const effectiveRate = markdown.excluded ? 0 : rate;
  const discount = round(line.unitPrice * line.quantity * effectiveRate);
  return { ...line, markdownRate: effectiveRate, markdownAmount: discount, event: markdown.event || null };
}

function applyCheckoutMarkdown(line) {
  const markdown = CHECKOUT_MARKDOWNS[line.variantId];
  return markdownLine(line, markdown);
}

function priceBag(lines) {
  const priced = lines.map(applyCheckoutMarkdown);
  const merchandise = round(priced.reduce((sum, l) => sum + l.unitPrice * l.quantity, 0));
  const markdown = round(priced.reduce((sum, l) => sum + l.markdownAmount, 0));
  const subtotal = round(merchandise - markdown);
  const shipping = subtotal >= FREE_SHIPPING_THRESHOLD ? 0 : STANDARD_SHIPPING;
  const tax = round(subtotal * SALES_TAX_RATE);
  return {
    lines: priced,
    merchandise,
    markdown,
    subtotal,
    shipping,
    tax,
    total: round(subtotal + shipping + tax),
    promotion: markdown > 0 ? FRIENDS_AND_FAMILY.label : null,
  };
}

function findColor(variantId) {
  return PRODUCT.colors.find((c) => c.variantId === String(variantId));
}

function buildLine(data) {
  const color = findColor(data.variantId);
  if (!color) throw validationError(`Unknown color variant: ${data.variantId || '(none)'}`, 'UNKNOWN_VARIANT');
  if (!PRODUCT.sizes.includes(data.size)) throw validationError('Choose a size before checking out', 'SIZE_REQUIRED');
  const fit = PRODUCT.fits.includes(data.fit) ? data.fit : 'Regular';
  const quantity = Number.parseInt(data.quantity, 10);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw validationError('Quantity must be between 1 and 10', 'INVALID_QUANTITY');
  return {
    styleNumber: PRODUCT.styleNumber,
    variantId: color.variantId,
    name: PRODUCT.name,
    color: color.name,
    fit,
    size: data.size,
    quantity,
    unitPrice: PRODUCT.price,
  };
}

async function placeOrder(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const line = buildLine(data);

  logger.info('Pricing bag for checkout', {
    requestId,
    styleNumber: line.styleNumber,
    variantId: line.variantId,
    color: line.color,
    size: line.size,
    quantity: line.quantity,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const pricing = priceBag([line]);
    const duration = Date.now() - startTime;
    incrementMetric('gap_pdp_checkout.success', { route: ROUTE, variantId: line.variantId });
    recordTiming('gap_pdp_checkout.latency', duration, { route: ROUTE });
    return {
      success: true,
      status: 'placed',
      orderNumber: `1G${String(Date.now()).slice(-8)}`,
      requestId,
      pricing,
      estimatedDelivery: 'Arrives in 3–5 business days',
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    if (error.statusCode === 400) {
      error.requestId = requestId;
      throw error;
    }

    incrementMetric('gap_pdp_checkout.failure', { route: ROUTE, errorClass: error.name, variantId: line.variantId });
    recordTiming('gap_pdp_checkout.latency', duration, { route: ROUTE, error: 'true' });

    const context = {
      requestId,
      styleNumber: line.styleNumber,
      variantId: line.variantId,
      color: line.color,
      fit: line.fit,
      size: line.size,
      quantity: line.quantity,
      promotion: FRIENDS_AND_FAMILY.code,
    };

    logger.error('Checkout failed while applying the Friends & Family markdown', {
      ...context,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
      route: ROUTE,
    });

    if (data.synthetic) {
      logger.info('Reproduction run — checkout failed without raising Sentry, Slack or a Devin session', { requestId, route: ROUTE });
      error.requestId = requestId;
      throw error;
    }

    const tags = { route: ROUTE, service: SERVICE, variantId: line.variantId, promotion: FRIENDS_AND_FAMILY.code, alert_path: 'instant' };

    Sentry.captureException(error, { tags, extra: context });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=${encodeURIComponent(SENTRY_ISSUE_QUERY)}`,
      datadogUrl: datadogLogsUrl(),
      culprit: 'app/services/verticals/2b43150a.js — markdownLine',
      errorType: error.name || 'Error',
      errorValue: error.message,
      service: SERVICE,
      verticalLabel: 'Gap — Relaxed Polo Sweater checkout',
      customer: '2b43150a',
      slackMemberId: data.devinEmail ? '' : GAP_SLACK_MEMBER_ID,
      slackMemberIdFallback: GAP_SLACK_MEMBER_ID,
      devinUserId: data.devinUserId || GAP_DEVIN_USER_ID,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      extra: context,
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
    }).catch((alertError) => {
      logger.error('Failed to create Devin session for Gap checkout error', { requestId, error: alertError.message });
    });

    error.requestId = requestId;
    throw error;
  }
}

module.exports = {
  placeOrder,
  priceBag,
  applyCheckoutMarkdown,
  markdownLine,
  datadogLogsUrl,
  CHECKOUT_MARKDOWNS,
  FRIENDS_AND_FAMILY,
  PRODUCT,
  DATADOG_LOGS_QUERY,
  REMEDIATION_DIRECTIVE,
};
