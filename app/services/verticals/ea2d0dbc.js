const { randomUUID } = require('crypto');
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../devin-session');
const logger = require('../../telemetry/logger');

const CUSTOMER = 'ea2d0dbc';
const SERVICE = 'customer-ea2d0dbc-checkout';
const ROUTE = 'POST /api/ea2d0dbc/checkout';
const CULPRIT = 'app/services/verticals/ea2d0dbc.js — quoteFulfillment';
const ASSETS = '/verticals/ea2d0dbc-assets/';

// Product copy and prices from the November 18, 2025 Best Gift Ideas snapshot.
const CATALOG = [
  ['4000391547', 'MAX STUDIO', '2pc Hockey Jersey Snuggletail Throw And Hockey Puck Friend Set', 24.99, 35, 'Blue', 'One Size', 'gift-bundle'],
  ['4000414178', 'DISNEY', 'Minnie Gingerbread House Cookie Jar', 29.99, 50, 'Pink', 'One Size', 'standard'],
  ['4000383495', 'BROUK AND CO', 'Roll Up Backgammon Set', 39.99, 75, 'Brown', 'One Size', 'standard'],
  ['4000289982', 'NHL', 'Nhl Arcade Pro Pinball Machine', 129.99, 225, 'Blue', 'One Size', 'oversized'],
  ['4000408746', 'NATASHA', 'Faux Crystal Stones And Pearl Bag', 39.99, 70, 'White', 'One Size', 'standard'],
  ['4000376971', 'WHITE + WARREN', 'Cashmere Rhinestone Button Cardigan', 129.99, 200, 'Grey', 'M', 'standard'],
  ['4000435561', 'MELODY MAKERS', 'Electric Guitar Toy', 19.99, 32, 'Red', 'One Size', 'standard'],
  ['4000390181', 'FOSSIL', "Men's Stainless Steel Fenmore Leather Strap Watch", 49.99, 70, 'Brown', 'One Size', 'standard'],
  ['4000364495', 'H2OGO!', 'Pirate Paradise Splash Pad', 14.99, 20, 'Blue', 'One Size', 'standard'],
  ['4000314952', 'KURT S ADLER', 'Christmas Icons Mini Projector', 19.99, 40, 'Red', 'One Size', 'standard'],
  ['4000394832', 'ROSANNA TABLEWARE', 'Enchanted Woods Peace Mug', 9.99, 16, 'White', 'One Size', 'standard'],
  ['4000437917', 'MY BEAUTY SPOT', 'Face And Neck Sculptor', 24.99, 32, 'Pink', 'One Size', 'standard'],
  ['4000384444', 'FOSSIL', "Men's Green Autocross Multifunction Stainless Steel Watch", 79.99, 124, 'Green', 'One Size', 'standard'],
  ['4000424696', 'OTBT', 'Made In Portugal Suede Story Booties', 59.99, 120, 'Brown', '8', 'standard'],
  ['4000383834', 'VINCE CAMUTO', 'Suede Hobo With Studded Trim', 79.99, 150, 'Brown', 'One Size', 'standard'],
  ['4000367544', 'ASPEN', '2pc Cashmere Hoodie And Pants Set', 179.99, 260, 'Grey', 'M', 'standard'],
  ['4000442602', 'RBX', 'Electric Foot Massager', 29.99, 43, 'Black', 'One Size', 'standard'],
  ['4000432389', 'AVEC LES FILLES', 'Paneled Faux Fur Hooded Vest', 49.99, 71, 'Brown', 'M', 'standard'],
  ['4000340457', 'LA CANADIENNE', 'Suede London Mid Rise Boots', 179.99, 250, 'Black', '8', 'standard'],
  ['4000413059', 'Reveal Designer', '1.7oz The One Eau De Parfum', 59.99, 120, 'Gold', 'One Size', 'standard'],
  ['4000430529', 'MISSONI', 'Made In Italy Scarf', 59.99, 85, 'Multi', 'One Size', 'standard'],
  ['4000441288', 'A&B HOME', '12x12 Wooden Tic Tac Toe Game Set', 29.99, 38, 'Brown', 'One Size', 'standard'],
  ['4000375842', 'Reveal Designer', 'Cashmere Mayfair Sweater', 129.99, 200, 'Blue', 'M', 'standard'],
  ['4000332306', 'FOXY BAE', 'Rose Gold Tone Super Styler', 49.99, 62, 'Pink', 'One Size', 'standard'],
].map(([sku, brand, name, price, compareAt, color, size, shippingClass]) => ({
  sku, brand, name, price, compareAt, color, size, shippingClass, image: `${ASSETS}${sku}.jpg`,
}));

// The holiday catalog introduced gift-bundle, but fulfillment still uses the old class table.
const FULFILLMENT_RULES = {
  standard: { handlingFee: 0 },
  oversized: { handlingFee: 14.99 },
};

const REMEDIATION_DIRECTIVE = [
  'Investigate and fix COG-GTM/event-driven-devin. Open a pull request against main; do not merge or deploy.',
  'Marshalls Best Gift Ideas (/marshalls or /ea2d0dbc) fails at Place Order when the bag contains the',
  'MAX STUDIO 2pc Hockey Jersey Snuggletail Throw And Hockey Puck Friend Set (SKU 4000391547).',
  'Reproduce: Quick Look on the first product → Add To Bag → Checkout → Place Order.',
  'The DISNEY Minnie Gingerbread House Cookie Jar succeeds on its own.',
  'Inspect app/services/verticals/ea2d0dbc.js, app/routes/verticals/ea2d0dbc.js and app/public/verticals/ea2d0dbc.html.',
  'The holiday catalog introduced shippingClass gift-bundle. It must ship at the standard rate with zero handling surcharge.',
  'Keep all products available and preserve standard/oversized shipping, SHIP89 and quantity validation.',
  'Add regression coverage in tests/ea2d0dbc-checkout.test.js and update the planted-failure expectation after the fix.',
  'Do not disable Sentry or alerts, swallow the exception, or replace the real checkout request with a client-side success.',
].join('\n');

const round2 = value => Math.round(value * 100) / 100;

function invalid(message, code) {
  return Object.assign(new Error(message), { name: 'ValidationError', status: 400, code });
}

function buildLines(items) {
  if (!Array.isArray(items) || items.length === 0 || items.length > 24) {
    throw invalid('Your bag must contain between 1 and 24 items.', 'INVALID_BAG');
  }
  const seen = new Set();
  return items.map(item => {
    const product = CATALOG.find(p => p.sku === item?.sku);
    if (!product) throw invalid('That product is not available.', 'UNKNOWN_PRODUCT');
    if (seen.has(product.sku)) throw invalid('Combine duplicate bag items.', 'DUPLICATE_PRODUCT');
    seen.add(product.sku);
    if (!Number.isSafeInteger(item.qty) || item.qty < 1 || item.qty > 10) {
      throw invalid('Choose a quantity between 1 and 10.', 'INVALID_QUANTITY');
    }
    return { ...product, qty: item.qty, lineTotal: round2(product.price * item.qty) };
  });
}

function quoteFulfillment(lines, promoCode) {
  const subtotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  const handling = round2(lines.reduce((sum, line) => {
    const rule = FULFILLMENT_RULES[line.shippingClass];
    return sum + rule.handlingFee * line.qty;
  }, 0));
  const shipping = round2((promoCode === 'SHIP89' && subtotal >= 89 ? 0 : 9.99) + handling);
  const tax = round2(subtotal * 0.0625);
  return { subtotal, shipping, tax, total: round2(subtotal + shipping + tax), currency: 'USD' };
}

async function placeOrder(data = {}) {
  const lines = buildLines(data.items);
  if (data.promoCode != null && typeof data.promoCode !== 'string') throw invalid('Enter a valid promo code.', 'INVALID_PROMO');
  const promoCode = (data.promoCode || '').trim().toUpperCase();
  if (promoCode && promoCode !== 'SHIP89') throw invalid('Promo code not recognized.', 'INVALID_PROMO');
  const orderId = randomUUID();
  try {
    const totals = quoteFulfillment(lines, promoCode);
    logger.info('Marshalls order confirmed', { service: SERVICE, orderId, total: totals.total });
    return { success: true, orderNumber: `M-${orderId.slice(0, 8).toUpperCase()}`, ...totals, lines, status: 'confirmed' };
  } catch (error) {
    const context = { orderId, skus: lines.map(l => l.sku), shippingClasses: lines.map(l => l.shippingClass), promoCode };
    const tags = { route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: 'instant' };
    Sentry.captureException(error, { tags, extra: context });
    logger.error('Marshalls checkout failed', { ...context, service: SERVICE, error: error.message });
    logger.info('Posting alert and triggering Devin', { service: SERVICE, orderId });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: CULPRIT,
      errorType: error.name,
      errorValue: error.message,
      customer: CUSTOMER,
      service: SERVICE,
      verticalLabel: 'Marshalls — Gift Checkout',
      level: 'error',
      platform: 'node',
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })),
      extra: context,
    }).catch(err => logger.error('Failed to create Devin session for Marshalls checkout', { error: err.message, orderId }));
    throw Object.assign(error, { status: 500, code: 'CHECKOUT_FAILED' });
  }
}

module.exports = { CATALOG, CUSTOMER, SERVICE, ROUTE, CULPRIT, REMEDIATION_DIRECTIVE, buildLines, quoteFulfillment, placeOrder };
