/**
 * Foot Locker — New Arrivals: product listing → quick add → bag → checkout.
 *
 * Models the footlocker.com /category/new-arrivals.html path: the PLP
 * catalogue, per-size-scale validation for each bag line, FLX member
 * shipping and sales tax, and the FLX points the order earns.
 *
 * Intentional demo defect: `SIZE_SCALES` holds the fulfilment size scale
 * for each product group the catalogue carried when the table was written
 * (Men's, Grade School, Preschool and apparel). The New Arrivals feed now
 * also lists Infant & Toddler styles, so `resolveSizeScale()` returns
 * `undefined` for a Toddler line and `validateSize()` crashes reading
 * `.sizes` off it.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');

const SERVICE = 'customer-footlocker-checkout';
const ROUTE = '/api/footlocker/checkout';
const MAX_LINE_QTY = 5;
const MAX_BAG_LINES = 15;
const FLX_POINTS_PER_DOLLAR = 100;

const IMAGE_BASE = 'https://images.footlocker.com/is/image/EBFL2';

function image(sku, size = 250) {
  return `${IMAGE_BASE}/${sku}?wid=${size}&hei=${size}`;
}

function swatch(sku, name) {
  return { sku, name, image: image(sku, 35) };
}

/** Product groups the PLP shows under the style name. */
const GROUPS = {
  mens: { code: 'mens', label: "Men's" },
  'grade-school': { code: 'grade-school', label: 'Big Kids (Grade School)' },
  preschool: { code: 'preschool', label: 'Little Kids (Preschool)' },
  toddler: { code: 'toddler', label: 'Infant & Toddler' },
  apparel: { code: 'apparel', label: 'Apparel & Accessories' },
};

/** Fulfilment size scale for each product group. */
const SIZE_SCALES = {
  mens: { sizes: ['7.0', '7.5', '8.0', '8.5', '9.0', '9.5', '10.0', '10.5', '11.0', '11.5', '12.0', '13.0', '14.0'], note: 'US Men\u2019s sizing' },
  'grade-school': { sizes: ['3.5', '4.0', '4.5', '5.0', '5.5', '6.0', '6.5', '7.0'], note: 'US Big Kids\u2019 sizing (3.5Y\u20137Y)' },
  preschool: { sizes: ['10.5', '11.0', '11.5', '12.0', '12.5', '13.0', '13.5', '1.0', '1.5', '2.0', '2.5', '3.0'], note: 'US Little Kids\u2019 sizing (10.5C\u20133Y)' },
  apparel: { sizes: ['S', 'M', 'L', 'XL', 'XXL', 'OSFA'], note: 'Apparel sizing' },
};

/** Sizes the product feed lists for each group (what the quick-add picker renders). */
const FEED_SIZES = {
  mens: SIZE_SCALES.mens.sizes,
  'grade-school': SIZE_SCALES['grade-school'].sizes,
  preschool: SIZE_SCALES.preschool.sizes,
  toddler: ['2.0', '3.0', '4.0', '5.0', '6.0', '7.0', '8.0', '9.0', '10.0'],
  apparel: SIZE_SCALES.apparel.sizes,
};

const CATALOG = [
  {
    sku: 'HQ797800', name: 'Jordan Retro 5 OG', group: "Men's", scale: 'mens', color: 'Black / Orange / Glow Green', price: 215, rating: 5, reviews: 333,
    swatches: [],
  },
  {
    sku: 'HQ627980', name: 'Jordan Retro 5', group: "Boys' Grade School", scale: 'grade-school', color: 'Picante Red / Glow In The Dark / Black', price: 155, rating: 5, reviews: 366,
    swatches: [swatch('HQ627980', 'Picante Red/Glow In The Dark/Black'), swatch('62798010', 'White/Silver/Black')],
  },
  {
    sku: 'H7423400', name: 'Nike Caitlin 1', group: "Men's", scale: 'mens', color: 'Multi / Blue / Caitlin Blue', price: 140, rating: 5, reviews: 34,
    swatches: [swatch('H7423400', 'Multi/Blue/Caitlin Blue'), swatch('H7423600', 'Neo Pink/Midnight Fever')],
  },
  {
    sku: 'Q5495005', name: 'Jordan Retro 1 High OG', group: "Men's", scale: 'mens', color: 'Black / Royal Blue / White', price: 185, rating: 5, reviews: 1149,
    swatches: [swatch('Q5495005', 'Black/Royal Blue/White'), swatch('Z5485201', 'Multi/Shadow Brown')],
  },
  {
    sku: 'HQ649001', name: 'Jordan Retro 5', group: "Boys' Preschool", scale: 'preschool', color: 'Picante Red / Glow In The Dark / Black', price: 95, rating: 5, reviews: 76,
    swatches: [swatch('HQ649001', 'Picante Red/Glow In The Dark/Black'), swatch('64797910', 'White/Silver/Black')],
  },
  {
    sku: 'HQ618100', name: 'Jordan Retro 5', group: "Boys' Toddler", scale: 'toddler', color: 'Picante Red / Glow In The Dark / Black', price: 80, rating: 5, reviews: 72,
    swatches: [],
  },
  {
    sku: '61046984', name: 'New Era Knicks 9FIFTY Finals Champion Cap', group: "Men's", scale: 'apparel', color: 'White / Multi', price: 46,
    swatches: [],
  },
  {
    sku: 'M4135401', name: 'Nike JA 4', group: "Men's", scale: 'mens', color: 'Blue / Blue / Black', price: 140, rating: 4, reviews: 40,
    swatches: [swatch('M4135401', 'Blue/Blue/Black'), swatch('M4135100', 'Black/White/Blue')],
  },
  {
    sku: 'Z1207010', name: 'Nike Air Force 1 Low LE', group: "Men's", scale: 'mens', color: 'Black / Gym Red / Summit White', price: 125, rating: 4, reviews: 7,
    swatches: [swatch('Z1207010', 'Black/Gym Red/Summit White'), swatch('R0951201', 'Tan/Silver/Tan')],
  },
  {
    sku: 'IV617558', name: 'Nike Little Posite Pro', group: "Boys' Toddler", scale: 'toddler', color: 'White / Black / Summit White', price: 77, rating: 4, reviews: 20,
    swatches: [swatch('IV617558', 'White/Black/Summit White'), swatch('IV617554', 'Black/Green')],
  },
  {
    sku: 'O6424010', name: 'Nike Knicks Pregame T-Shirt', group: "Men's", scale: 'apparel', color: 'Black', price: 60,
    swatches: [],
  },
  {
    sku: 'IZ425325', name: 'Nike Air Max 90', group: "Men's", scale: 'mens', color: 'Black / Orange / Wheat', price: 145, rating: 5, reviews: 1428,
    swatches: [swatch('IZ425325', 'Black/Orange/Wheat'), swatch('M0029122', 'Blue Crystal/Light Smoke Grey/White')],
  },
  {
    sku: 'SY226Z04', name: 'Saucony Omni 9', group: "Boys' Grade School", scale: 'grade-school', color: 'Navy / Multi', price: 90,
    swatches: [swatch('SY226Z04', 'Navy/Multi'), swatch('SY226Z40', 'Beige/Gradient Brown')],
  },
  {
    sku: 'IQ4110', name: 'Nike Kobe IV', group: "Boys' Grade School", scale: 'grade-school', color: 'Glacier Blue / White', price: 122,
    swatches: [],
  },
  {
    sku: 'JA425100', name: 'Nike Air Max 90', group: "Men's", scale: 'mens', color: 'White / Orange / Grey', price: 135, rating: 5, reviews: 1428,
    swatches: [swatch('JA425100', 'White/Orange/Grey'), swatch('M0029122', 'Blue Crystal/Light Smoke Grey/White')],
  },
  {
    sku: 'SL424921', name: 'Salomon XT-6', group: "Men's", scale: 'mens', color: 'Navy / Black / Silver', price: 185, rating: 5, reviews: 2477,
    swatches: [swatch('SL424921', 'Navy/Black/Silver'), swatch('L4547280', 'Griseille/Pearl Blue/Vanilla Ice')],
  },
  {
    sku: 'Q7198001', name: 'Nike Air Max Goadome', group: "Men's", scale: 'mens', color: 'White / Anthracite / Black', price: 200, rating: 5, reviews: 676,
    swatches: [swatch('Q7198001', 'White/Anthracite/Black'), swatch('20143097', 'Brown')],
  },
  {
    sku: 'X7257133', name: 'Nike Air Force 1 Low LE', group: "Men's", scale: 'mens', color: 'Summit White / Yellow Ochre / Midnight Navy', price: 125, rating: 4, reviews: 7,
    swatches: [swatch('X7257133', 'Summit White/Yellow Ochre/Midnight Navy'), swatch('R0951201', 'Tan/Silver/Tan')],
  },
  {
    sku: 'IR208260', name: 'Jordan AJ 40-14', group: "Men's", scale: 'mens', color: 'Red / Yellow / Black', price: 200,
    swatches: [],
  },
  {
    sku: 'A5N6T01T', name: 'Timberland Premium 6" Waterproof Boots', group: "Girls' Toddler", scale: 'toddler', color: 'Medium Beige / Dark Brown', price: 100, rating: 5, reviews: 5,
    swatches: [swatch('A5N6T01T', 'Medium Beige/Dark Brown'), swatch('A6BE6A5V', 'Pink/Pink')],
  },
  {
    sku: 'T6837242', name: 'Timberland Field Boots Chukka', group: "Boys' Toddler", scale: 'toddler', color: 'Green / Brown', price: 80, rating: 5, reviews: 2,
    swatches: [],
  },
  {
    sku: 'IH659001', name: 'Nike Manoa Boots', group: "Boys' Grade School", scale: 'grade-school', color: 'Black / Black', price: 95, rating: 5, reviews: 4,
    swatches: [],
  },
  {
    sku: 'UG659066', name: 'UGG Tasman', group: "Girls' Grade School", scale: 'grade-school', color: 'Pink / Pink', price: 90, rating: 5, reviews: 1,
    swatches: [],
  },
  {
    sku: 'M9605200', name: 'Nike Air Max 95', group: "Men's", scale: 'mens', color: 'Cream / Lt Orewood Brown / Moon Fossil', price: 190, rating: 4, reviews: 121,
    swatches: [swatch('M9605200', 'Cream/Lt Orewood Brown/Moon Fossil'), swatch('H4740007', 'Black/White/Med Ash Gray')],
  },
  {
    sku: 'V3472700', name: 'Nike Air Force 1 \'07 LV8 CS', group: "Men's", scale: 'mens', color: 'Wheat / Wheat', price: 125,
    swatches: [],
  },
  {
    sku: '7397KCH2', name: 'UGG Mini Bailey Bow', group: "Girls' Toddler", scale: 'toddler', color: 'Chestnut / Chestnut', price: 140,
    swatches: [swatch('7397KCH2', 'Chestnut/Chestnut'), swatch('7397TBLK', 'Black/Black')],
  },
  {
    sku: 'FD621437', name: 'Jordan Retro 1 High OG', group: "Boys' Grade School", scale: 'grade-school', color: 'Black / Blue', price: 140, rating: 5, reviews: 234,
    swatches: [swatch('FD621437', 'Black/Blue'), swatch('D1437201', 'Shadow Brown/Black')],
  },
  {
    sku: 'IQ625244', name: 'Jordan AJ 1 Low SE', group: "Girls' Grade School", scale: 'grade-school', color: 'Black / Pink / White', price: 110, rating: 5, reviews: 5,
    swatches: [swatch('IQ625244', 'Black/Pink/White'), swatch('B7111004', 'Half Blue/Vapor Green/Sail')],
  },
  {
    sku: 'TB463824', name: 'Timberland 6" Premium Waterproof Boot', group: "Men's", scale: 'mens', color: 'Duffel Bag', price: 220,
    swatches: [],
  },
  {
    sku: 'V3782101', name: 'Nike Air Zoom Huarache 2K4', group: "Men's", scale: 'mens', color: 'White / Hyper Cobalt / Varsity Maize', price: 190, rating: 4, reviews: 73,
    swatches: [],
  },
  {
    sku: 'IQ616070', name: 'Jordan Retro 6 Low', group: "Girls' Toddler", scale: 'toddler', color: 'Multi / Black', price: 60, rating: 5, reviews: 8,
    swatches: [],
  },
  {
    sku: 'HQ424308', name: 'Nike Mind 002', group: "Men's", scale: 'mens', color: 'Phantom', price: 145, rating: 4, reviews: 40,
    swatches: [swatch('HQ424308', 'Phantom'), swatch('42430801', 'Silver/Black/Orange')],
  },
  {
    sku: '00D9RCJK', name: 'Vans LX Old Skool 36', group: "Men's", scale: 'mens', color: 'Black / Black', price: 110, rating: 5, reviews: 3,
    swatches: [swatch('00D9RCJK', 'Black/Black'), swatch('VND9RDJR', 'Turtle Dove')],
  },
  {
    sku: 'SL226X40', name: 'Saucony Omni 9', group: "Girls' Toddler", scale: 'toddler', color: 'Brown / Brown', price: 65, rating: 5, reviews: 5,
    swatches: [swatch('SL226X40', 'Brown/Brown'), swatch('SL168174', 'Pink/Silver')],
  },
  {
    sku: 'I0402601', name: 'Nike Sabrina 4', group: "Men's", scale: 'mens', color: 'Black / Infrared / Bright Crimson', price: 135, rating: 4, reviews: 30,
    swatches: [swatch('I0402601', 'Black/Infrared/Bright Crimson'), swatch('II040210', 'Gray/White')],
  },
  {
    sku: 'DQ648424', name: 'Jordan AJ 1 Mid', group: "Girls' Preschool", scale: 'preschool', color: 'White / Blue', price: 75, rating: 5, reviews: 127,
    swatches: [swatch('DQ648424', 'White/Blue'), swatch('Q8424601', 'Pink Foam/China Rose/Pink Foam')],
  },
  {
    sku: '1383190H', name: 'Crocs Classic Clogs', group: "Men's", scale: 'mens', color: 'Multi', price: 70, rating: 5, reviews: 81,
    swatches: [swatch('1383190H', 'Multi'), swatch('10001BLK', 'Black/Black')],
  },
  {
    sku: 'IU630103', name: 'Nike V5 RNR Shine', group: "Girls' Grade School", scale: 'grade-school', color: 'White / Grey / Silver', price: 80, rating: 5, reviews: 42,
    swatches: [],
  },
  {
    sku: 'LB3878', name: 'adidas Originals Samba Sequin', group: "Girls' Grade School", scale: 'grade-school', color: 'Wonder Mauve / Pink', price: 90, rating: 5, reviews: 510,
    swatches: [],
  },
  {
    sku: 'A23947C', name: 'Converse Throwback HI', group: "Men's", scale: 'mens', color: 'Dark Root / Black', price: 90,
    swatches: [],
  },
  {
    sku: 'IQ640600', name: 'Jordan Retro 6 Low', group: "Girls' Preschool", scale: 'preschool', color: 'Black / Multi', price: 85, rating: 4, reviews: 11,
    swatches: [],
  },
  {
    sku: 'A23975C', name: 'Converse Shai 001 Ox', group: "Men's", scale: 'mens', color: 'Black / Green Beam / Black', price: 140, rating: 5, reviews: 3,
    swatches: [swatch('A23975C', 'Black/Green Beam/Black'), swatch('A23978C', 'Blue/Blue')],
  },
  {
    sku: '4A169106', name: 'ASICS® GEL-1130', group: "Boys' Grade School", scale: 'grade-school', color: 'Blue / Silver / Tan', price: 95, rating: 5, reviews: 40,
    swatches: [swatch('4A169106', 'Blue/Silver/Tan'), swatch('AS639108', 'White/Silver/Brown')],
  },
  {
    sku: 'H2232603', name: 'Nike A\'Two', group: "Girls' Grade School", scale: 'grade-school', color: 'Pink / Black / White', price: 112,
    swatches: [swatch('H2232603', 'Pink/Black/White'), swatch('R4334800', 'Orange Pulse/Metallic Silver/Sail')],
  },
  {
    sku: '2410TDYR', name: 'UGG Lowmel', group: "Girls' Toddler", scale: 'toddler', color: 'Dusty Orchid / Dusty Orchid', price: 100, rating: 5, reviews: 12,
    swatches: [swatch('2410TDYR', 'Dusty Orchid/Dusty Orchid'), swatch('11521339', 'Tan/Tan')],
  },
  {
    sku: 'IO455621', name: 'Nike Baltoro Boots', group: "Men's", scale: 'mens', color: 'Black / Light British Tan / Geode Teal', price: 145, rating: 5, reviews: 2,
    swatches: [swatch('IO455621', 'Black/Light British Tan/Geode Teal'), swatch('IO455622', 'Geode Teal/Lt British Tan/Black')],
  },
  {
    sku: '10269408', name: 'Reebok Classic Leather', group: "Boys' Preschool", scale: 'preschool', color: 'White / New Grey / Legacy Blue', price: 45,
    swatches: [],
  },
  {
    sku: 'R0088001', name: 'Jordan AJ 1 Retro Low OG', group: "Men's", scale: 'mens', color: 'Varsity Red / Black / White', price: 155, rating: 5, reviews: 39,
    swatches: [swatch('R0088001', 'Varsity Red/Black/White'), swatch('Q6998600', 'White/Red/Black')],
  },
].map((product) => ({
  ...product,
  image: image(product.sku),
  sizes: FEED_SIZES[product.scale],
  swatches: product.swatches.length ? product.swatches : [swatch(product.sku, product.color)],
}));

const SHIPPING_METHODS = {
  standard: { code: 'standard', label: 'Standard', fee: 7.99, freeForFlx: true, eta: '3-6 business days' },
  express: { code: 'express', label: 'Express', fee: 14.99, freeForFlx: false, eta: '2 business days' },
  pickup: { code: 'pickup', label: 'Store Pickup', fee: 0, freeForFlx: true, eta: 'Ready in 2 hours' },
};

/** Combined state + local sales tax for the shipping destination. */
const STATE_TAX = {
  NY: { label: 'NY sales tax (8.875%)', rate: 0.08875 },
  NJ: { label: 'NJ sales tax (6.625%)', rate: 0.06625 },
  CA: { label: 'CA sales tax (9.5%)', rate: 0.095 },
  TX: { label: 'TX sales tax (8.25%)', rate: 0.0825 },
  FL: { label: 'FL sales tax (7%)', rate: 0.07 },
  IL: { label: 'IL sales tax (10.25%)', rate: 0.1025 },
  WI: { label: 'WI sales tax (5.5%)', rate: 0.055 },
  OR: { label: 'No sales tax', rate: 0 },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the Foot Locker New Arrivals checkout vertical:',
  '- Service: `app/services/verticals/footlocker.js`',
  '- Route: `app/routes/verticals/footlocker.js`',
  '- Page: `app/public/verticals/footlocker.html` (served at `/footlocker`)',
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
  const rule = resolveOption(STATE_TAX, normalized, 'NY', 'UNSUPPORTED_STATE');
  return { code: normalized, ...rule };
}

/**
 * Fulfilment size scale for a product's group. Returns the scale
 * definition, or `undefined` when the group has no entry in the table.
 */
function resolveSizeScale(product) {
  return SIZE_SCALES[product.scale];
}

function normalizeSize(size) {
  const text = String(size === undefined || size === null ? '' : size).trim().toUpperCase();
  if (/^\d+(\.\d)?$/.test(text)) return Number(text).toFixed(1);
  return text;
}

function validateSize(product, size) {
  const scale = resolveSizeScale(product);
  const wanted = normalizeSize(size);
  if (!scale.sizes.includes(wanted)) {
    throw validationError(`Size ${size} is not available for ${product.name}`, 'INVALID_SIZE');
  }
  return wanted;
}

function resolveColor(product, colorSku) {
  if (colorSku === undefined || colorSku === null || colorSku === '') return product.swatches[0];
  const color = product.swatches.find((item) => item.sku === colorSku || item.name === colorSku);
  if (!color) throw validationError(`Color ${colorSku} is not available for ${product.name}`, 'INVALID_COLOR');
  return color;
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
    return {
      sku: product.sku,
      name: product.name,
      group: product.group,
      color: color.name,
      size,
      qty,
      unitPrice: product.price,
      lineTotal: round2(product.price * qty),
      image: product.image,
    };
  });
}

function computeShippingFee(shipping, flxMember) {
  if (shipping.freeForFlx && flxMember) return 0;
  return shipping.fee;
}

function buildOrderSummary({
  orderId, lines, shipping, taxRule, flxMember,
}) {
  const subtotal = round2(lines.reduce((sum, line) => sum + line.lineTotal, 0));
  const shippingFee = computeShippingFee(shipping, flxMember);
  const tax = round2((subtotal + shippingFee) * taxRule.rate);
  const total = round2(subtotal + shippingFee + tax);

  return {
    orderId,
    orderNumber: `FL${orderId.replace(/-/g, '').slice(0, 10).toUpperCase()}`,
    lines,
    subtotal,
    shipping: {
      method: shipping.label,
      fee: shippingFee,
      eta: shipping.eta,
      complimentary: shippingFee === 0 && shipping.fee > 0,
    },
    tax: { label: taxRule.label, amount: tax },
    total,
    flxMember: Boolean(flxMember),
    flxPoints: flxMember ? Math.round(subtotal * FLX_POINTS_PER_DOLLAR) : 0,
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
  const flxMember = Boolean(data.flxMember);
  const requestedGroups = Array.isArray(data.items)
    ? data.items.map((item) => (findProduct(item && item.sku) || {}).scale).filter(Boolean)
    : [];

  logger.info('Placing Foot Locker order', {
    orderId,
    lines: Array.isArray(data.items) ? data.items.length : 0,
    shipping: shipping.code,
    state: taxRule.code,
    flxMember,
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
      orderId, lines, shipping, taxRule, flxMember,
    });

    const duration = Date.now() - startTime;
    incrementMetric('fl_checkout.success', { route: ROUTE, shipping: shipping.code, flx_member: String(flxMember) });
    recordTiming('fl_checkout.latency', duration, { route: ROUTE });

    logger.info('Foot Locker order confirmed', {
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

    incrementMetric('fl_checkout.failure', {
      route: ROUTE,
      errorClass: error.name,
      shipping: shipping.code,
    });
    recordTiming('fl_checkout.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Foot Locker checkout failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      shipping: shipping.code,
      state: taxRule.label,
      groups: requestedGroups,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        shipping: shipping.code,
        alert_path: 'instant',
      },
      extra: {
        orderId,
        groups: requestedGroups,
        flxMember,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/footlocker.js \u2014 validateSize',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Foot Locker Checkout',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'footlocker',
      level: 'error',
      platform: 'node',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'shipping', value: shipping.code },
      ],
      extra: {
        orderId,
        groups: requestedGroups,
        flxMember,
        shipping: shipping.code,
      },
    }).catch((err) => {
      logger.error('Failed to create Devin session for Foot Locker checkout error', {
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
  GROUPS,
  SIZE_SCALES,
  FEED_SIZES,
  SHIPPING_METHODS,
  STATE_TAX,
  MAX_BAG_LINES,
  MAX_LINE_QTY,
  FLX_POINTS_PER_DOLLAR,
  buildBagLines,
  resolveSizeScale,
  validateSize,
  computeShippingFee,
  buildOrderSummary,
};
