/**
 * Canadian Tire — Triangle Rewards checkout.
 *
 * Models the canadiantire.ca cart → checkout path for a Triangle Rewards
 * member: catalogue lookup, fulfilment (ship-to-home vs. in-store pickup),
 * Ontario HST, and the CT Money earn calculation that runs on every order.
 *
 * Intentional demo defect: the "Big Truck Tire Sale" bonus event advertises
 * 30x CT Money on all tires, but `BONUS_EVENTS.BTTS30X.eligibleCategories`
 * only lists the categories that existed when the event was configured.
 * Winter tires were added to the catalogue later, so `resolveBonusEvent()`
 * returns `undefined` for a winter-tire line and `computeCtMoney()` crashes
 * reading `.multiplier` off it.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-10397dc6-checkout';
const ROUTE = '/api/10397dc6/checkout';
const MAX_LINE_QTY = 99;

/** Sales tax by destination province. */
const PROVINCIAL_TAX = {
  ON: { label: 'HST (13%)', rate: 0.13 },
  BC: { label: 'GST (5%) + PST (7%)', rate: 0.12 },
};

const CATALOG = [
  {
    sku: '0078551',
    name: 'MotoMaster Winter Edge II Tire, 225/65R17 102T',
    brand: 'MotoMaster',
    category: 'winter-tires',
    price: 179.99,
    wasPrice: 224.99,
    unit: 'each',
    image: 'https://media-www.canadiantire.ca/product/automotive/tires/winter-tires/0078551/-225-65r17-t-motomaster-winter-edge-ii-76c0b870-9c3b-4d82-a461-1cd218d17f83-jpgrendition.jpg?im=whresize&wid=640&hei=480',
  },
  {
    sku: '0072021',
    name: 'MotoMaster Hydra Edge Tour All Season Tire, 225/65R17 102H',
    brand: 'MotoMaster',
    category: 'all-season-tires',
    price: 164.99,
    wasPrice: 199.99,
    unit: 'each',
    image: 'https://media-www.canadiantire.ca/product/automotive/tires/all-season-tires/0072021/225-65r17-102h-motomaster-hydra-edge-tour-d10dfa65-ba19-4a9e-a90c-e5aa9b3f531c-jpgrendition.jpg?im=whresize&wid=640&hei=480',
  },
  {
    sku: '0063098',
    name: 'MotoMaster Performance Edge Tire, P205/55R16 91W',
    brand: 'MotoMaster',
    category: 'performance-tires',
    price: 139.99,
    wasPrice: 169.99,
    unit: 'each',
    image: 'https://media-www.canadiantire.ca/product/automotive/tires/performance-tires/0063098/p205-55r16-91w-motomaster-performance-edge-a150ff0b-1d36-4c0b-865e-b3bf54c901d0-jpgrendition.jpg?im=whresize&wid=640&hei=480',
  },
  {
    sku: '1427071',
    name: 'Heritage The Rock 10-pc Forged Non-Stick Cookware Set',
    brand: 'Heritage',
    category: 'cookware',
    price: 199.99,
    wasPrice: 449.99,
    unit: 'set',
    image: 'https://media-www.canadiantire.ca/product/living/kitchen/cookware/1427071/heritage-rock-10pc-forged-non-stick-0ebbea60-846c-4da6-92dc-7e48329322ee-jpgrendition.jpg?im=whresize&wid=640&hei=480',
  },
  {
    sku: '0680002',
    name: 'Mastercraft Work Centre with Pegboard & Light',
    brand: 'Mastercraft',
    category: 'garage-storage',
    price: 349.99,
    wasPrice: 499.99,
    unit: 'each',
    image: 'https://media-www.canadiantire.ca/product/fixing/tools/garage-organization/0680002/mastercraft-work-center-4036e5da-fd71-44f2-882b-eeb6e67956d0-jpgrendition.jpg?im=whresize&wid=640&hei=480',
  },
  {
    sku: '0396176',
    name: 'Armor All All-Purpose Car Wash, 1.89 L',
    brand: 'Armor All',
    category: 'car-care',
    price: 9.99,
    wasPrice: 12.99,
    unit: 'each',
    image: 'https://media-www.canadiantire.ca/product/automotive/car-care-accessories/auto-cleaning-chemicals/0396176/armor-all-all-purpose-car-wash-1-89-l-70e102b9-be75-4b98-a1f4-5787952ad0d6-jpgrendition.jpg?im=whresize&wid=640&hei=480',
  },
];

const STORES = {
  'ON-0128': { id: 'ON-0128', name: 'Toronto (Leslie & Lakeshore), ON', province: 'ON', pickupHours: '8am - 9pm' },
  'ON-0043': { id: 'ON-0043', name: 'Mississauga (Heartland), ON', province: 'ON', pickupHours: '8am - 9pm' },
  'BC-0311': { id: 'BC-0311', name: 'Victoria (Hillside Centre), BC', province: 'BC', pickupHours: '8am - 9pm' },
};

const FULFILMENT_METHODS = {
  'ship-to-home': { code: 'ship-to-home', label: 'Ship to Home', fee: 9.99, freeOver: 99, eta: '3-5 business days' },
  'pickup-in-store': { code: 'pickup-in-store', label: 'Pick Up In-Store', fee: 0, freeOver: 0, eta: 'Ready in 2 hours' },
};

/**
 * Base CT Money earn rates by tender (fraction of pre-tax spend).
 * Triangle Rewards card: 0.4%. Triangle Mastercard: 4% on CT purchases.
 */
const TENDERS = {
  'triangle-rewards': { code: 'triangle-rewards', label: 'Triangle Rewards card', earnRate: 0.004 },
  'triangle-mastercard': { code: 'triangle-mastercard', label: 'Triangle Mastercard', earnRate: 0.04 },
  'triangle-world-elite': { code: 'triangle-world-elite', label: 'Triangle World Elite Mastercard', earnRate: 0.04 },
};

/**
 * Bonus CT Money events. `eligibleCategories` gates which cart lines earn
 * the multiplier; lines outside it earn base only.
 */
const BONUS_EVENTS = {
  BTTS30X: {
    code: 'BTTS30X',
    label: 'Big Truck Tire Sale — 30x CT Money on tires',
    multiplier: 30,
    scope: 'tires',
    tenders: ['triangle-mastercard', 'triangle-world-elite'],
    eligibleCategories: ['all-season-tires', 'performance-tires'],
  },
  KITCHEN10X: {
    code: 'KITCHEN10X',
    label: '10x CT Money on kitchen',
    multiplier: 10,
    scope: 'kitchen',
    tenders: ['triangle-rewards', 'triangle-mastercard', 'triangle-world-elite'],
    eligibleCategories: ['cookware', 'small-appliances'],
  },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Canadian Tire Triangle Rewards checkout vertical:',
  '- Service: `app/services/verticals/10397dc6.js`',
  '- Route: `app/routes/verticals/10397dc6.js`',
  '- Page: `app/public/verticals/10397dc6.html` (served at `/canadiantire`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function round2(value) {
  return Math.round(value * 100) / 100;
}

function findProduct(sku) {
  return CATALOG.find((product) => product.sku === sku) || null;
}

function resolveStore(storeId) {
  return STORES[storeId] || STORES['ON-0128'];
}

function resolveFulfilment(code) {
  return FULFILMENT_METHODS[code] || FULFILMENT_METHODS['ship-to-home'];
}

function resolveTender(code) {
  return TENDERS[code] || TENDERS['triangle-rewards'];
}

function validationError(message, code) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

function buildCartLines(items) {
  if (!Array.isArray(items)) {
    throw validationError('Cart items must be an array', 'INVALID_CART');
  }
  return items.map((item) => {
    const product = findProduct(item && item.sku);
    if (!product) {
      throw validationError(`Unknown SKU: ${item && item.sku}`, 'UNKNOWN_SKU');
    }
    const qty = Number(item.qty);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
      throw validationError(`Invalid quantity for SKU ${product.sku}`, 'INVALID_QUANTITY');
    }
    return {
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      category: product.category,
      price: product.price,
      qty,
      lineTotal: round2(product.price * qty),
    };
  });
}

/**
 * Look up the bonus event that applies to a given cart line for a tender.
 * Returns the event definition, or `undefined` when the line is not
 * eligible (or the event does not exist / the tender is excluded).
 */
function resolveBonusEvent(promoCode, line, tender) {
  const event = BONUS_EVENTS[(promoCode || '').trim().toUpperCase()];
  if (!event) return undefined;
  if (!event.tenders.includes(tender.code)) return undefined;
  if (!event.eligibleCategories.includes(line.category)) return undefined;
  return event;
}

/**
 * CT Money earned on a single cart line.
 * Base earn always applies; a bonus event multiplies it for eligible lines.
 */
function computeCtMoney(line, tender, promoCode) {
  const base = line.lineTotal * tender.earnRate;
  const bonus = resolveBonusEvent(promoCode, line, tender);
  const event = BONUS_EVENTS[promoCode] || null;
  const isTire = line.category.endsWith('-tires');

  // Tire events advertise the multiplier on every tire line.
  if (event && event.scope === 'tires' && isTire && event.tenders.includes(tender.code)) {
    return round2(base * bonus.multiplier);
  }
  return round2(bonus ? base * bonus.multiplier : base);
}

function computeFulfilmentFee(fulfilment, subtotal) {
  if (fulfilment.freeOver && subtotal >= fulfilment.freeOver) return 0;
  return fulfilment.fee;
}

function buildOrderSummary({
  orderId, lines, tender, fulfilment, store, promoCode,
}) {
  const subtotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  const savings = round2(lines.reduce((sum, line) => {
    const product = findProduct(line.sku);
    return product && product.wasPrice ? sum + (product.wasPrice - product.price) * line.qty : sum;
  }, 0));
  const fulfilmentFee = computeFulfilmentFee(fulfilment, subtotal);
  const province = fulfilment.code === 'pickup-in-store' ? store.province : 'ON';
  const taxRule = PROVINCIAL_TAX[province] || PROVINCIAL_TAX.ON;
  const tax = round2((subtotal + fulfilmentFee) * taxRule.rate);
  const total = round2(subtotal + fulfilmentFee + tax);
  const ctMoney = round2(lines.reduce((sum, line) => sum + computeCtMoney(line, tender, promoCode), 0));

  return {
    orderId,
    orderNumber: `CT-${orderId.slice(0, 8).toUpperCase()}`,
    lines,
    subtotal,
    savings,
    fulfilment: {
      method: fulfilment.label,
      fee: fulfilmentFee,
      eta: fulfilment.eta,
      store: fulfilment.code === 'pickup-in-store' ? store.name : null,
    },
    tax: { label: taxRule.label, province, amount: tax },
    total,
    rewards: {
      tender: tender.label,
      promoCode: promoCode || null,
      ctMoneyEarned: ctMoney,
    },
    currency: 'CAD',
    status: 'confirmed',
    createdAt: new Date().toISOString(),
  };
}

async function placeOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();
  const lines = buildCartLines(data.items || []);
  if (lines.length === 0) {
    throw validationError('Cart is empty', 'EMPTY_CART');
  }
  const tender = resolveTender(data.tender);
  const fulfilment = resolveFulfilment(data.fulfilment);
  const store = resolveStore(data.storeId);
  const promoCode = (data.promoCode || '').trim().toUpperCase() || null;

  logger.info('Placing Canadian Tire order', {
    orderId,
    lines: lines.length,
    tender: tender.code,
    fulfilment: fulfilment.code,
    storeId: store.id,
    promoCode,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const summary = buildOrderSummary({
      orderId, lines, tender, fulfilment, store, promoCode,
    });

    const duration = Date.now() - startTime;
    incrementMetric('ct_checkout.success', { route: ROUTE, tender: tender.code, promo: promoCode || 'none' });
    recordTiming('ct_checkout.latency', duration, { route: ROUTE });

    logger.info('Canadian Tire order confirmed', {
      orderId,
      orderNumber: summary.orderNumber,
      total: summary.total,
      ctMoneyEarned: summary.rewards.ctMoneyEarned,
      durationMs: duration,
      service: SERVICE,
    });

    return summary;
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('ct_checkout.failure', {
      route: ROUTE,
      errorClass: error.name,
      tender: tender.code,
      promo: promoCode || 'none',
    });
    recordTiming('ct_checkout.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Canadian Tire checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      tender: tender.code,
      fulfilment: fulfilment.code,
      storeId: store.id,
      promoCode,
      lines: lines.length,
      categories: lines.map((line) => line.category),
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        tender: tender.code,
        promo: promoCode || 'none',
      },
      extra: {
        orderId,
        promoCode,
        storeId: store.id,
        fulfilment: fulfilment.code,
        lines: lines.length,
        categories: lines.map((line) => line.category),
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/10397dc6.js \u2014 computeCtMoney',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Canadian Tire Checkout',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '10397dc6',
      level: 'error',
      platform: 'node',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'tender', value: tender.code },
        { key: 'promo', value: promoCode || 'none' },
      ],
      extra: {
        orderId,
        promoCode,
        storeId: store.id,
        fulfilment: fulfilment.code,
        lines: lines.length,
        categories: lines.map((line) => line.category),
      },
    }).catch((err) => {
      logger.error('Failed to create Devin session for Canadian Tire checkout error', {
        error: err.message,
        orderId,
      });
    });

    throw error;
  }
}

module.exports = {
  placeOrder,
  REMEDIATION_DIRECTIVE,
  CATALOG,
  STORES,
  FULFILMENT_METHODS,
  TENDERS,
  BONUS_EVENTS,
  buildCartLines,
  resolveBonusEvent,
  computeCtMoney,
  computeFulfilmentFee,
  buildOrderSummary,
};
