/**
 * Ralph Lauren — men's polo shirts: product listing → bag → checkout.
 *
 * Models the ralphlauren.com /men-clothing-polo-shirts path: the PLP
 * catalogue, fit/size validation for each bag line, monogramming, RL
 * Account free shipping and New York sales tax.
 *
 * Intentional demo defect: `FIT_SIZE_RUNS` holds the size run for each
 * polo fit the catalogue had when the table was written (Classic, Custom
 * Slim, Relaxed). The Fall/Holiday 2026 drop added Tailored Fit
 * performance polos, so `resolveSizeRun()` returns `undefined` for a
 * Tailored Fit line and `validateSize()` crashes reading `.sizes` off it.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-ralphlauren-checkout';
const ROUTE = '/api/ralphlauren/checkout';
const MAX_LINE_QTY = 10;
const MAX_BAG_LINES = 20;
const MONOGRAM_FEE = 10;
const MONOGRAM_RE = /^[A-Za-z]{1,3}$/;

const IMAGE_BASE = 'https://dtcralphlauren.scene7.com/is/image/PoloGSI';

function image(id, preset = '$plpDeskRF$') {
  return `${IMAGE_BASE}/s7-${id}?${preset}`;
}

function swatch(id, name) {
  return { id, name, image: `${IMAGE_BASE}/swatch_${id}` };
}

/** Men's polo fits and the size run each one is cut in. */
const FITS = {
  classic: { code: 'classic', label: 'Classic Fit', description: 'Our most generous cut, with a fuller chest and body' },
  'custom-slim': { code: 'custom-slim', label: 'Custom Slim Fit', description: 'Trim through the chest and body, with a shorter length' },
  tailored: { code: 'tailored', label: 'Tailored Fit', description: 'Sits close to the body with a tapered waist' },
  relaxed: { code: 'relaxed', label: 'Relaxed Fit', description: 'A roomy, boxy silhouette with a dropped shoulder' },
};

const FIT_SIZE_RUNS = {
  classic: { sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'], note: 'Runs true to size' },
  'custom-slim': { sizes: ['XS', 'S', 'M', 'L', 'XL', 'XXL'], note: 'Consider sizing up for a Classic-like fit' },
  relaxed: { sizes: ['S', 'M', 'L', 'XL'], note: 'Oversized; size down for a closer fit' },
};

const CATALOG = [
  {
    sku: '401480-P',
    name: 'The Iconic Mesh Polo Shirt - All Fits',
    brand: 'Polo Ralph Lauren',
    fit: 'classic',
    price: 118,
    salePrice: 89.99,
    saleLabel: 'Select Colors',
    image: image('1266689_alternate10'),
    hoverImage: image('1266689_lifestyle'),
    colorCount: 49,
    swatches: [swatch('1266689', 'White/Navy'), swatch('AI710534735517', 'Polo Black'), swatch('1504795', 'French Navy'), swatch('AI710534735531', 'Cruise Navy'), swatch('AI710534735520', 'Spring Lime')],
    monogram: true,
  },
  {
    sku: '401482-P',
    name: 'Soft Cotton Polo Shirt - All Fits',
    brand: 'Polo Ralph Lauren',
    fit: 'classic',
    price: 110,
    priceMax: 118,
    salePrice: 74.99,
    saleLabel: 'Select items from',
    image: image('1266704_alternate10'),
    hoverImage: image('1266704_lifestyle'),
    colorCount: 19,
    swatches: [swatch('1266704', 'Polo Black'), swatch('1266707', 'Aviator Navy'), swatch('1410987', 'Faded Black Canvas'), swatch('AI710660606502', 'Sand Heather'), swatch('1504796', 'Classic Khaki')],
    monogram: true,
  },
  {
    sku: '413706-P',
    name: 'Mesh Long-Sleeve Polo Shirt \u2013 All Fits',
    brand: 'Polo Ralph Lauren',
    fit: 'classic',
    price: 120,
    salePrice: 115,
    saleLabel: 'Select Colors',
    image: image('AI710680792079_alternate10'),
    hoverImage: image('AI710680792079_lifestyle'),
    colorCount: 12,
    swatches: [swatch('AI710680792079', 'Canterbury Heather'), swatch('AI710680792500', 'Polo Black'), swatch('1417177', 'Newport Navy'), swatch('1449670', 'White'), swatch('AI710680792502', 'Hunter Navy')],
    monogram: false,
  },
  {
    sku: '545294',
    name: 'Classic Fit Soft Cotton Polo Shirt',
    brand: 'Polo Ralph Lauren',
    fit: 'classic',
    price: 125,
    image: image('1412512_alternate10'),
    hoverImage: image('1412512_lifestyle'),
    colorCount: 6,
    swatches: [swatch('1412512', 'Bastille Blue Heather'), swatch('1379265', 'Polo Black'), swatch('AI710671784501', 'French Navy'), swatch('1379266', 'Dark Cobalt Heather'), swatch('AI710671784020', 'Classic Wine')],
    monogram: false,
  },
  {
    sku: '100092564',
    name: 'Relaxed Fit Mesh Polo Shirt',
    brand: 'Polo Ralph Lauren',
    fit: 'relaxed',
    price: 118,
    image: image('AI710B18907004_alternate10'),
    hoverImage: image('AI710B18907004_lifestyle'),
    colorCount: 2,
    swatches: [swatch('AI710B18907004', 'Nantucket Red'), swatch('AI710B18907006', 'Cruise Navy')],
    monogram: false,
  },
  {
    sku: '100007278',
    name: 'Custom Slim Fit Stretch Mesh Polo Shirt',
    brand: 'Polo Ralph Lauren',
    fit: 'custom-slim',
    price: 118,
    salePrice: 89.99,
    saleLabel: 'Select Colors',
    image: image('AI710941439001_alternate10'),
    hoverImage: image('AI710941439001_lifestyle'),
    colorCount: 9,
    swatches: [swatch('AI710941439001', 'White'), swatch('AI710941439002', 'Polo Black'), swatch('AI710941439521', 'Newport Navy'), swatch('AI710941439004', 'Sport Grey Heather'), swatch('AI710941439509', 'Cruise Navy')],
    monogram: false,
  },
  {
    sku: '100034201',
    name: 'Pink Pony Stretch Mesh Polo Shirt',
    brand: 'Polo Ralph Lauren',
    fit: 'custom-slim',
    price: 125,
    image: image('AI710941783001_alternate1'),
    hoverImage: image('AI710941783001_lifestyle'),
    colorCount: 2,
    swatches: [swatch('AI710941783001', 'White'), swatch('AI710941783500', 'Pink Pony Pink')],
    monogram: false,
    promo: 'Pink Pony: 25% of the purchase price supports the fight against cancer',
  },
  {
    sku: '582999',
    name: 'Custom Slim Fit Mesh Polo Shirt',
    brand: 'Polo Ralph Lauren',
    fit: 'custom-slim',
    price: 120,
    image: image('1411023_alternate10'),
    hoverImage: image('1411023_lifestyle'),
    colorCount: 3,
    swatches: [swatch('1411023', 'Rl Navy'), swatch('AI710842621504', 'White'), swatch('AI710842621505', 'Polo Black')],
    monogram: true,
  },
  {
    sku: '100100199',
    name: 'Custom Slim Fit Camo Mesh Polo Shirt',
    brand: 'Polo Ralph Lauren',
    fit: 'custom-slim',
    price: 125,
    image: image('AI710B24446001_alternate10'),
    hoverImage: image('AI710B24446001_lifestyle'),
    colorCount: 1,
    swatches: [swatch('AI710B24446001', 'Surplus Camo')],
    monogram: false,
  },
  {
    sku: '100098525',
    name: 'Tailored Fit Performance Polo Shirt',
    brand: 'Polo Ralph Lauren',
    fit: 'tailored',
    price: 135,
    image: image('AI785B18643003_alternate10'),
    hoverImage: image('AI785B18643003_lifestyle'),
    colorCount: 2,
    swatches: [swatch('AI785B18643003', 'Refined Navy'), swatch('AI785B18643001', 'Ceramic White')],
    monogram: false,
    badge: 'New Arrival',
  },
  {
    sku: '100096516',
    name: 'Tailored Fit Performance Zip Polo Shirt',
    brand: 'Polo Ralph Lauren',
    fit: 'tailored',
    price: 125,
    image: image('AI785B28822001_alternate10'),
    hoverImage: image('AI785B28822001_lifestyle'),
    colorCount: 1,
    swatches: [swatch('AI785B28822001', 'Polo Black')],
    monogram: false,
    badge: 'New Arrival',
  },
  {
    sku: '100042568',
    name: 'Classic Fit Performance Polo Shirt',
    brand: 'Polo Ralph Lauren',
    fit: 'classic',
    price: 120,
    image: image('AI785964031003_alternate10'),
    hoverImage: image('AI785964031003_lifestyle'),
    colorCount: 5,
    swatches: [swatch('AI785964031003', 'French Navy'), swatch('AI785964031001', 'Pure White'), swatch('AI785964031005', 'Refined Navy'), swatch('AI785964031004', 'Andover Heather'), swatch('AI785964031002', 'Polo Black')],
    monogram: false,
  },
];

const SHIPPING_METHODS = {
  standard: { code: 'standard', label: 'Standard', fee: 10, freeWithAccount: true, eta: '3-5 business days' },
  express: { code: 'express', label: 'Express', fee: 20, freeWithAccount: false, eta: '2 business days' },
  'same-day': { code: 'same-day', label: 'Same Day', fee: 25, freeWithAccount: false, eta: 'Today by 9pm (NYC)' },
};

/** Combined state + local sales tax for the shipping destination. */
const STATE_TAX = {
  NY: { label: 'NY sales tax (8.875%)', rate: 0.08875 },
  NJ: { label: 'NJ sales tax (6.625%)', rate: 0.06625 },
  CT: { label: 'CT sales tax (6.35%)', rate: 0.0635 },
  CA: { label: 'CA sales tax (9.5%)', rate: 0.095 },
  TX: { label: 'TX sales tax (8.25%)', rate: 0.0825 },
  FL: { label: 'FL sales tax (7%)', rate: 0.07 },
  IL: { label: 'IL sales tax (10.25%)', rate: 0.1025 },
  OR: { label: 'No sales tax', rate: 0 },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Ralph Lauren men\u2019s polo shirts checkout vertical:',
  '- Service: `app/services/verticals/ralphlauren.js`',
  '- Route: `app/routes/verticals/ralphlauren.js`',
  '- Page: `app/public/verticals/ralphlauren.html` (served at `/ralphlauren`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function round2(value) {
  return Math.round(value * 100) / 100;
}

function findProduct(sku) {
  return CATALOG.find((product) => product.sku === sku) || null;
}

function validationError(message, code) {
  const err = new Error(message);
  err.code = code;
  err.status = 400;
  return err;
}

function resolveOption(table, code, fallbackCode, errorCode) {
  if (code === undefined || code === null || code === '') return table[fallbackCode];
  const option = Object.prototype.hasOwnProperty.call(table, code) ? table[code] : undefined;
  if (!option) throw validationError(`Unsupported ${errorCode.toLowerCase().replace(/_/g, ' ')}: ${code}`, errorCode);
  return option;
}

function resolveShipping(code) {
  return resolveOption(SHIPPING_METHODS, code, 'standard', 'UNKNOWN_SHIPPING_METHOD');
}

function resolveState(state) {
  const normalized = String(state || 'NY').trim().toUpperCase();
  return resolveOption(STATE_TAX, normalized, 'NY', 'UNSUPPORTED_STATE');
}

/**
 * Size run for a product's fit. Returns the run definition, or `undefined`
 * when the fit has no entry in the table.
 */
function resolveSizeRun(product) {
  return FIT_SIZE_RUNS[product.fit];
}

function validateSize(product, size) {
  const run = resolveSizeRun(product);
  const wanted = String(size || '').trim().toUpperCase();
  if (!run.sizes.includes(wanted)) {
    throw validationError(`Size ${size} is not available for ${product.name}`, 'INVALID_SIZE');
  }
  return wanted;
}

function resolveColor(product, colorId) {
  if (colorId === undefined || colorId === null || colorId === '') return product.swatches[0];
  const color = product.swatches.find((item) => item.id === colorId || item.name === colorId);
  if (!color) throw validationError(`Color ${colorId} is not available for ${product.name}`, 'INVALID_COLOR');
  return color;
}

function resolveMonogram(product, monogram) {
  if (monogram === undefined || monogram === null || monogram === '') return null;
  if (!product.monogram) throw validationError(`Monogramming is not offered on ${product.name}`, 'MONOGRAM_UNAVAILABLE');
  const text = String(monogram).trim().toUpperCase();
  if (!MONOGRAM_RE.test(text)) throw validationError('Monogram must be 1-3 letters', 'INVALID_MONOGRAM');
  return text;
}

function buildBagLines(items) {
  if (!Array.isArray(items)) {
    throw validationError('Bag items must be an array', 'INVALID_BAG');
  }
  if (items.length > MAX_BAG_LINES) {
    throw validationError(`Bag may contain at most ${MAX_BAG_LINES} lines`, 'BAG_TOO_LARGE');
  }
  return items.map((item) => {
    const product = findProduct(item && item.sku);
    if (!product) {
      throw validationError(`Unknown style: ${item && item.sku}`, 'UNKNOWN_SKU');
    }
    const qty = Number(item.qty);
    if (!Number.isSafeInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
      throw validationError(`Invalid quantity for ${product.sku}`, 'INVALID_QUANTITY');
    }
    const color = resolveColor(product, item.color);
    const size = validateSize(product, item.size);
    const monogram = resolveMonogram(product, item.monogram);
    const unitPrice = product.salePrice && item.onSale !== false ? product.salePrice : product.price;
    const monogramFee = monogram ? MONOGRAM_FEE : 0;
    return {
      sku: product.sku,
      name: product.name,
      brand: product.brand,
      fit: FITS[product.fit].label,
      color: color.name,
      size,
      monogram,
      qty,
      unitPrice,
      listPrice: product.price,
      monogramFee,
      lineTotal: round2((unitPrice + monogramFee) * qty),
      image: product.image,
    };
  });
}

function computeShippingFee(shipping, rlAccount) {
  if (shipping.freeWithAccount && rlAccount) return 0;
  return shipping.fee;
}

function buildOrderSummary({
  orderId, lines, shipping, taxRule, rlAccount,
}) {
  const subtotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  const savings = round2(lines.reduce((sum, line) => sum + (line.listPrice - line.unitPrice) * line.qty, 0));
  const shippingFee = computeShippingFee(shipping, rlAccount);
  const tax = round2((subtotal + shippingFee) * taxRule.rate);
  const total = round2(subtotal + shippingFee + tax);

  return {
    orderId,
    orderNumber: `RL${orderId.replace(/-/g, '').slice(0, 10).toUpperCase()}`,
    lines,
    subtotal,
    savings,
    shipping: {
      method: shipping.label,
      fee: shippingFee,
      eta: shipping.eta,
      complimentary: shippingFee === 0 && shipping.fee > 0,
    },
    tax: { label: taxRule.label, amount: tax },
    total,
    rlAccount: Boolean(rlAccount),
    currency: 'USD',
    status: 'confirmed',
    createdAt: new Date().toISOString(),
  };
}

async function placeOrder(data) {
  const startTime = Date.now();
  const orderId = uuidv4();
  const shipping = resolveShipping(data.shippingMethod);
  const taxRule = resolveState(data.state);
  const rlAccount = Boolean(data.rlAccount);
  const requestedFits = Array.isArray(data.items)
    ? data.items.map((item) => (findProduct(item && item.sku) || {}).fit).filter(Boolean)
    : [];

  logger.info('Placing Ralph Lauren order', {
    orderId,
    lines: Array.isArray(data.items) ? data.items.length : 0,
    shipping: shipping.code,
    state: data.state || 'NY',
    rlAccount,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const lines = buildBagLines(data.items || []);
    if (lines.length === 0) {
      throw validationError('Your bag is empty', 'EMPTY_BAG');
    }

    await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));

    const summary = buildOrderSummary({
      orderId, lines, shipping, taxRule, rlAccount,
    });

    const duration = Date.now() - startTime;
    incrementMetric('rl_checkout.success', { route: ROUTE, shipping: shipping.code, rl_account: String(rlAccount) });
    recordTiming('rl_checkout.latency', duration, { route: ROUTE });

    logger.info('Ralph Lauren order confirmed', {
      orderId,
      orderNumber: summary.orderNumber,
      total: summary.total,
      lines: lines.length,
      durationMs: duration,
      service: SERVICE,
    });

    return summary;
  } catch (error) {
    if (error.status === 400) throw error;

    const duration = Date.now() - startTime;

    incrementMetric('rl_checkout.failure', {
      route: ROUTE,
      errorClass: error.name,
      shipping: shipping.code,
    });
    recordTiming('rl_checkout.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Ralph Lauren checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      shipping: shipping.code,
      state: taxRule.label,
      fits: requestedFits,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        shipping: shipping.code,
      },
      extra: {
        orderId,
        fits: requestedFits,
        rlAccount,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/ralphlauren.js \u2014 validateSize',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Ralph Lauren Checkout',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'ralphlauren',
      level: 'error',
      platform: 'node',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'shipping', value: shipping.code },
      ],
      extra: {
        orderId,
        fits: requestedFits,
        rlAccount,
        shipping: shipping.code,
      },
    }).catch((err) => {
      logger.error('Failed to create Devin session for Ralph Lauren checkout error', {
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
  FITS,
  FIT_SIZE_RUNS,
  SHIPPING_METHODS,
  STATE_TAX,
  MONOGRAM_FEE,
  buildBagLines,
  resolveSizeRun,
  validateSize,
  computeShippingFee,
  buildOrderSummary,
};
