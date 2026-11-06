const { randomUUID } = require('crypto');
const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../devin-session');
const logger = require('../../telemetry/logger');
const CATALOG = require('../../public/verticals/4ff94526-assets/catalog.json');

const CUSTOMER = '4ff94526';
const SERVICE = 'customer-4ff94526-pizza-builder';
const ROUTE = 'POST /api/4ff94526/cart';
const CULPRIT = 'app/services/verticals/4ff94526.js — quotePizza';
const SIZES = { small: 9.99, medium: 11.99, large: 13.99 };
const CRUST_SIZES = {
  HANDTOSS: ['small', 'medium', 'large'], PSC: ['large'], NPAN: ['medium'],
  THIN: ['medium', 'large'], BK: ['medium', 'large'], GLUTENF: ['small'],
};

// The builder catalog adopted PSC; pricing still uses the legacy stuffed-crust key.
const CRUST_PRICING = {
  HANDTOSS: { surcharge: 0 }, PARMESAN_STUFFED: { surcharge: 3 }, NPAN: { surcharge: 2 },
  THIN: { surcharge: 0 }, BK: { surcharge: 0 }, GLUTENF: { surcharge: 2 },
};
const REMEDIATION_DIRECTIVE = [
  'Investigate and fix COG-GTM/event-driven-devin. Open a pull request against main; do not merge or deploy.',
  "Domino's Build Your Own Pizza (/dominos or /4ff94526) fails when adding Parmesan Stuffed Crust to the cart.",
  'Reproduce: select Parmesan Stuffed Crust → Large → Add To Cart. Hand Tossed succeeds.',
  'Inspect app/services/verticals/4ff94526.js, app/routes/verticals/4ff94526.js and app/public/verticals/4ff94526-assets/builder.js.',
  'The catalog uses crust code PSC but the pricing table still uses PARMESAN_STUFFED. The correct stuffed-crust surcharge is $3 per pizza.',
  'Keep every crust available; preserve size compatibility, topping/dip pricing, quantity validation and server-authoritative totals.',
  'Add regression coverage in tests/4ff94526-pizza.test.js and update the planted-failure expectation after the fix.',
  'Do not disable Sentry/alerts, swallow errors, remove the crust, or fake a successful cart response in the browser.',
].join('\n');
const round2 = n => Math.round(n * 100) / 100;
const invalid = message => Object.assign(new Error(message), { name: 'ValidationError', status: 400, code: 'INVALID_PIZZA' });

function validatePizza(pizza) {
  if (!pizza || typeof pizza !== 'object' || Array.isArray(pizza)) throw invalid('Choose your pizza options.');
  if (!Number.isSafeInteger(pizza.quantity) || pizza.quantity < 1 || pizza.quantity > 10) throw invalid('Choose a quantity between 1 and 10.');
  const clean = { quantity: pizza.quantity };
  for (const group of CATALOG) {
    const value = pizza[group.id];
    const options = group.options.map(o => o.id);
    if (group.multiple) {
      if (!Array.isArray(value) || value.length > options.length || new Set(value).size !== value.length || value.some(v => !options.includes(v))) throw invalid(`Choose valid ${group.label.toLowerCase()}.`);
      clean[group.id] = [...value];
    } else {
      if (!options.includes(value)) throw invalid(`Choose a valid ${group.label.toLowerCase()} option.`);
      clean[group.id] = value;
    }
  }
  if (!CRUST_SIZES[clean.crust].includes(pizza.size)) throw invalid('This size is not available for your crust.');
  clean.size = pizza.size;
  for (const field of ['saucePortion', 'cheesePortion']) {
    if (!['light', 'normal', 'extra'].includes(pizza[field])) throw invalid('Choose a valid portion.');
    clean[field] = pizza[field];
  }
  if (typeof pizza.instructions !== 'string' || pizza.instructions.length > 200) throw invalid('Keep special instructions under 200 characters.');
  clean.instructions = pizza.instructions.trim();
  return clean;
}

function quotePizza(pizza) {
  const crust = CRUST_PRICING[pizza.crust];
  const toppingCount = pizza.meats.length + pizza.veggies.length + pizza.extraCheese.length;
  const extraCheese = pizza.cheese === 'cheese' && pizza.cheesePortion === 'extra' ? 1.5 : 0;
  const unitPrice = round2(SIZES[pizza.size] + crust.surcharge + toppingCount * 1.5 + extraCheese + pizza.dips.length * 0.99);
  return { unitPrice, total: round2(unitPrice * pizza.quantity), currency: 'USD' };
}

async function addToCart(data = {}) {
  const pizza = validatePizza(data.pizza);
  const cartItemId = randomUUID();
  try {
    const totals = quotePizza(pizza);
    logger.info("Domino's pizza added to cart", { service: SERVICE, cartItemId, total: totals.total });
    return { success: true, cartItemId, pizza, ...totals };
  } catch (error) {
    const context = { cartItemId, crust: pizza.crust, size: pizza.size, quantity: pizza.quantity, toppingCount: pizza.meats.length + pizza.veggies.length + pizza.extraCheese.length };
    const tags = { route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: 'instant' };
    Sentry.captureException(error, { tags, extra: context });
    logger.error("Domino's pizza pricing failed", { ...context, service: SERVICE, error: error.message });
    logger.info('Posting alert and triggering Devin', { service: SERVICE, cartItemId });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: CULPRIT, errorType: error.name, errorValue: error.message,
      customer: CUSTOMER, service: SERVICE, verticalLabel: "Domino's — Pizza Builder",
      level: 'error', platform: 'node',
      devinUserId: data.devinUserId, devinOrgId: data.devinOrgId, devinEmail: data.devinEmail,
      promptAppendix: REMEDIATION_DIRECTIVE,
      tags: Object.entries(tags).map(([key, value]) => ({ key, value })), extra: context,
    }).catch(err => logger.error("Failed to create Devin session for Domino's pizza builder", { error: err.message, cartItemId }));
    throw Object.assign(error, { status: 500, code: 'PIZZA_CART_FAILED' });
  }
}

module.exports = { CATALOG, CUSTOMER, SERVICE, ROUTE, CULPRIT, CRUST_SIZES, REMEDIATION_DIRECTIVE, validatePizza, quotePizza, addToCart };
