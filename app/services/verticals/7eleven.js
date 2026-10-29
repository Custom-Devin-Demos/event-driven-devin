/**
 * 7NOW — 7-Eleven delivery storefront (replica of 7-eleven.com/7now/home).
 *
 * The home page shows the live 7NOW shelves (Offers, Late Night Essentials,
 * Hot Bites, Wickedly Delicious Pizza). Shoppers add items to the cart and
 * place a delivery order. Order placement assigns every line a fulfillment
 * handling rule by the product's temperature class so the store can pack
 * hot food, chilled drinks and ambient snacks in the right bag.
 *
 * Production incident: HANDLING_RULES was written for the original hot /
 * chilled / ambient assortment. The ice-cream shelf ships pints as
 * `temp: 'frozen'`, which has no handling rule, so `packLine()` reads
 * `.bagType` off `undefined` and throws a TypeError for any cart that
 * contains a frozen item. Orders without frozen items succeed.
 *
 * Monitoring: this service is observed by Amazon CloudWatch, so the
 * instant-path alert carries the CloudWatch alarm definition
 * (`alertData.cloudwatch`) and uses the `en-cloudwatch` vocabulary.
 */

const Sentry = require('@sentry/node');
const { createSessionAndAlert } = require('../devin-session');
const logger = require('../../telemetry/logger');

const SERVICE = 'customer-7eleven-checkout';
const ROUTE = '/api/7eleven/checkout';
const CUSTOMER = '7eleven';
const AWS_REGION = 'us-east-1';
const AWS_REGION_LABEL = 'US East (N. Virginia)';
const AWS_ACCOUNT_ID = '735612984401';
const ALARM_NAME = '7now-checkout-api-5xx-errors';
const LOG_GROUP = '/aws/ecs/7now-checkout-api';

const CDN = 'https://deuktbth81ifn.cloudfront.net/7now/US';
const OFFERS_CDN = 'https://images.contentstack.io/v3/assets/blt3bc3ff6be240f0a9';
const CATEGORY_CDN = 'https://d2l3f85c0g29u8.cloudfront.net/menu-assets/core-category-icons';

const DELIVERY_FEE = 2.99;
const SERVICE_FEE_RATE = 0.05;
const TAX_RATE = 0.0825;
const SMALL_BASKET_MIN = 10;
const SMALL_BASKET_FEE = 2.0;
const MAX_LINE_QTY = 10;
const MAX_CART_LINES = 25;

const CATEGORIES = [
  'Fresh Food', 'Drinks', 'Snacks', 'Candy', 'Ice Cream', 'Beer & Seltzer', 'Wine', 'Grocery', 'Household', 'Personal Care',
].map((label) => ({
  label,
  slug: label.toLowerCase().replace(/ & /g, '-').replace(/\s+/g, '-'),
  image: `${CATEGORY_CDN}/us-${label.toLowerCase().replace(/ & /g, '-').replace(/\s+/g, '-')}_v5.png`,
}));

const OFFERS = [
  { id: 'pizza-799', alt: '$7.99 Large Pizza', image: `${OFFERS_CDN}/blte344ae7737e6a8bb/6ad6d32712c2456104567755/UPDATE_6.99Pizza-1_7NHomepage.png` },
  { id: 'snickers-2', alt: '$2 Snickers', image: `${OFFERS_CDN}/bltadc0861945263d11/6abd9e367eb65ff6eaf0edf9/SNK_US_2026_7ElevenSnickersNFL_7NOWHeroBanner_Static_2058x1020_EN.png` },
  { id: 'pepsi-halloween', alt: 'PepsiCo Halloween', image: `${OFFERS_CDN}/bltcdecc03892fd45c9/6ae1224a55b21135d7b7d393/375-PCM-7E-PO1-Halloween-HomePg-Hero-2025x1020-R2-CutAsset.jpg` },
  { id: 'redbull', alt: 'Red Bull Feature', image: `${OFFERS_CDN}/blt3b3f9ea4f2a6e7e9/6abda0b9a120e253182d895c/1777431916254-dqQU742paN6hmDW4oTVEuA_large.jpg` },
  { id: 'fanta-2for5', alt: '2 for $5 Fanta Mix & Match', image: `${OFFERS_CDN}/blt8cda2e67d9007a09/6ac55aa6ee5ee3f56af03491/81025_7NowApp_DealTile_2058x1020_01_Fanta_(1).png` },
];

const BRANDS = [
  { name: 'Happy Halloweekend', image: `${CDN}/B-00036_Happy%20Halloweekend_7now_US/mwspzeturyqcpmobshmn.png` },
  { name: 'Big Gulp', image: `${CDN}/B-00007_Big%20Gulp_7now_US/bjd9uwcm4urzvv6wiwsr.png` },
  { name: 'Slurpee', image: `${CDN}/B-00006_Slurpee_7now_US/tuskvvecvy9tclovw4a9.png` },
  { name: '7-Select Drinks', image: `${CDN}/B-00011_7-Select%20Drinks_7now_US/dpkendhqnlwreaprscvl.png` },
  { name: '7-Select Ice Cream', image: `${CDN}/B-00013_7-Select%20Ice%20Cream_7now_US/ybaxprbmxgnrsmvsed2f.png` },
  { name: 'BeatBox', image: `${CDN}/B-00038_BeatBox_7now_US/b1ir69a3uzvcvmzgtjha.png` },
];

// temp: hot | chilled | ambient | frozen — drives the packing rule at checkout.
const CATALOG = [
  { id: '246630-0-1', name: 'Monster Energy Zero Ultra 16 Fl Oz', meta: '16oz · 10 Cal', price: 4.09, badge: '4 for $11', temp: 'chilled', image: `${CDN}/246630-0-1/68b0d2de3c32f61bb36eefc062d5882e6d4f1ce0.png` },
  { id: '241278-0-1', name: 'Red Bull Energy Drink, 12 fl. oz. Can, 114mg Caffeine, Taurine & B Vitamins', meta: '12oz · 160 Cal', price: 4.29, badge: '2 for $7.50', temp: 'chilled', image: `${CDN}/241278-0-1/hsqjynjhq2u3zzymdu0y.jpg` },
  { id: '190395-0-1', name: "Ben & Jerry's Half Baked Pint", meta: '1pt · 370 Cal', price: 7.49, wasPrice: 9.29, badge: 'On Sale $7.49', temp: 'frozen', image: `${CDN}/190395-0-1/vmy5wwss294ix5w4sma7.jpg` },
  { id: '140370-0-1', name: 'Gushers Tropical 4.25oz', meta: '4.25oz · 110 Cal', price: 3.69, temp: 'ambient', image: `${CDN}/140370-0-1/88390a14736268b5c9a3beb182561a74e6c8f69c.jpg` },
  { id: '300551-0-1', name: "Chester's Hot Fries 5.25oz", meta: '5.25oz · 150 Cal', price: 3.39, temp: 'ambient', image: `${CDN}/300551-0-1/xieqkvnqoidhphaptihh.jpg` },
  { id: '241945-0-1', name: 'Monster Energy, Original, Energy Drink, 16 Fl Oz', meta: '16oz · 230 Cal', price: 4.09, badge: '4 for $11', temp: 'chilled', image: `${CDN}/241945-0-1/d594ded1fca72833b7f5afcbee2863b4b49492ab.png` },
  { id: '190003-0-1', name: 'Ben & Jerry’s Chocolate Fudge Brownie Pint', meta: '1pt · 350 Cal', price: 7.49, wasPrice: 9.29, badge: 'On Sale $7.49', temp: 'frozen', image: `${CDN}/190003-0-1/ozu9urpfq84vozok3zay.jpg` },
  { id: '241342-0-1', name: 'Red Bull Sugarfree Energy Drink, 12 fl. oz. Can, 114mg Caffeine, Taurine & B Vitamins', meta: '12oz · 10 Cal', price: 4.29, badge: '2 for $7.50', temp: 'chilled', image: `${CDN}/241342-0-1/fnr7vw6p4fvsbmri0sb7.jpg` },
  { id: '178322-2-6-2', name: 'Large Pizza - Ultimate Pepperoni', meta: '1 Whole Pizza · 360 Cal', price: 7.99, wasPrice: 12.99, badge: 'On Sale $7.99', temp: 'hot', image: `${CDN}/178322-2-6-2/wghjlebnc3luzvgqmpvz.jpg` },
  { id: '673602-2-6-1', name: 'Large Pizza - Bibigo Korean BBQ', meta: '1 Whole Pizza', price: 11.99, temp: 'hot', image: `${CDN}/673602-2-6-1/ktlq1jvuyy4hkgmx0ehj.jpg` },
  { id: '172921-0-1-2', name: 'Chicken Wings - Spicy (5 piece)', meta: '5pc · 170 Cal', price: 5.0, wasPrice: 10.45, badge: '5pc for $5', temp: 'hot', image: `${CDN}/172921-0-1-2/c171916cc00a37a50cb823317e37b0ddb5a725d0.jpg` },
  { id: '176937-2-6-1', name: 'Large Pizza - 3 Meat', meta: '1 Whole Pizza · 450 Cal', price: 7.99, wasPrice: 12.99, badge: 'On Sale $7.99', temp: 'hot', image: `${CDN}/176937-2-6-1/q5pusmod8of1d0xgn7q2.jpg` },
  { id: '673229-0-1', name: 'Bibigo Spicy Chicken Dumplings 10ct', meta: '10ct', price: 5.0, wasPrice: 5.9, badge: '10ct for $5', temp: 'hot', image: `${CDN}/673229-0-1/ycdoulh5sp4inwi8j4x9.jpg` },
  { id: '171720-0-1', name: 'Steak & Cheese Taquito', meta: '1ct · 190 Cal', price: 2.49, badge: '$4 Combo: Arizona & 2 Taquitos', temp: 'hot', image: `${CDN}/171720-0-1/90d1ab3a0eaa0e123b4b3b4b7e36da225fcb59c5.jpg` },
  { id: '673201-0-1', name: 'Korean Gochujang Boneless Chicken Wings 8ct', meta: '8ct · 250 Cal', price: 5.0, wasPrice: 7.92, badge: '8pc for $5', temp: 'hot', image: `${CDN}/673201-0-1/sppmeycdsdy9rrnmnbtp.jpg` },
  { id: '673342-0-1', name: 'Chicken & Cheese Mini Tacos 8pc', meta: '8pc · 430 Cal', price: 3.0, wasPrice: 4.72, badge: '8pc for $3', temp: 'hot', image: `${CDN}/673342-0-1/cv4fdg2yabxj7fqnyzj6.jpg` },
  { id: '175401-2-6', name: 'Large Pizza - Cheese', meta: '1 Whole Pizza · 440 Cal', price: 7.99, wasPrice: 12.99, badge: 'On Sale $7.99', temp: 'hot', image: `${CDN}/175401-2-6/hys8fwwdiriydphxfz0g.jpg` },
  { id: '178322-2-6-1', name: 'Ready to Bake Pizza - Ultimate Pepperoni', meta: '1 Whole Pizza · 360 Cal', price: 7.99, wasPrice: 12.99, badge: 'On Sale $7.99', temp: 'chilled', image: `${CDN}/178322-2-6-1/fvgrhumbo39ygblru8jf.jpg` },
  { id: '176937-2-6-2', name: 'Ready to Bake Pizza - 3 Meat', meta: '1 Whole Pizza · 450 Cal', price: 7.99, wasPrice: 12.99, badge: 'On Sale $7.99', temp: 'chilled', image: `${CDN}/176937-2-6-2/zqf4fhkbi45syhboalvx.jpg` },
  { id: '175401-2-6-2', name: 'Ready to Bake Pizza - Cheese', meta: '1 Whole Pizza · 440 Cal', price: 7.99, wasPrice: 12.99, badge: 'On Sale $7.99', temp: 'chilled', image: `${CDN}/175401-2-6-2/lkfgsfyhodvzuo0tqxeu.jpg` },
];

const SHELVES = [
  { title: 'Late Night Essentials', ids: ['246630-0-1', '241278-0-1', '190395-0-1', '140370-0-1', '300551-0-1', '241945-0-1', '190003-0-1', '241342-0-1'] },
  { title: 'Hot Bites', ids: ['178322-2-6-2', '673602-2-6-1', '172921-0-1-2', '176937-2-6-1', '673229-0-1', '171720-0-1', '673201-0-1', '673342-0-1'] },
  { title: 'Wickedly Delicious Pizza', ids: ['178322-2-6-2', '176937-2-6-1', '175401-2-6', '178322-2-6-1', '176937-2-6-2', '175401-2-6-2'] },
];

/**
 * Store packing rules by temperature class. Written for the original hot /
 * chilled / ambient assortment; the ice-cream shelf (`temp: 'frozen'`) was
 * added to the catalog without a matching rule.
 */
const HANDLING_RULES = {
  hot: { bagType: 'insulated-hot', holdMinutes: 20, label: 'Hot food bag' },
  chilled: { bagType: 'cooler', holdMinutes: 45, label: 'Cooler bag' },
  ambient: { bagType: 'paper', holdMinutes: 120, label: 'Paper bag' },
};

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'The failing code path is the 7NOW (7-Eleven delivery) checkout vertical:',
  '- Service: `app/services/verticals/7eleven.js`',
  '- Route: `app/routes/verticals/7eleven.js`',
  '- Page: `app/public/verticals/7eleven.html` (served at `/7eleven`)',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function round2(value) {
  return Math.round(value * 100) / 100;
}

function findProduct(id) {
  return CATALOG.find((product) => product.id === id) || null;
}

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.status = 400;
  error.code = code;
  return error;
}

function normalizeItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    throw validationError('Your cart is empty', 'EMPTY_CART');
  }
  if (items.length > MAX_CART_LINES) {
    throw validationError(`Carts are limited to ${MAX_CART_LINES} items`, 'TOO_MANY_LINES');
  }
  return items.map((item) => {
    const product = findProduct(item && item.id);
    if (!product) throw validationError(`Unknown product: ${item && item.id}`, 'UNKNOWN_PRODUCT');
    const qty = item.qty === undefined ? 1 : Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_LINE_QTY) {
      throw validationError(`Quantity for ${product.name} must be between 1 and ${MAX_LINE_QTY}`, 'BAD_QTY');
    }
    return { product, qty };
  });
}

const ADDRESS_PLACEHOLDER = 'Add Address';

function normalizeAddress(address) {
  const trimmed = typeof address === 'string' ? address.trim() : '';
  if (!trimmed || trimmed.toLowerCase() === ADDRESS_PLACEHOLDER.toLowerCase()) {
    throw validationError('Add a delivery address before placing your order', 'ADDRESS_REQUIRED');
  }
  return trimmed;
}

/**
 * Assign the packing instruction for one cart line.
 * BUG: HANDLING_RULES has no entry for `frozen`, so the lookup is undefined
 * and reading `.bagType` throws a TypeError for ice cream.
 */
function packLine({ product, qty }) {
  const rule = HANDLING_RULES[product.temp];
  return {
    id: product.id,
    name: product.name,
    qty,
    unitPrice: product.price,
    lineTotal: round2(product.price * qty),
    bagType: rule.bagType,
    holdMinutes: rule.holdMinutes,
    handling: rule.label,
  };
}

function buildAlarm(timestamp) {
  const stamp = new Date(timestamp);
  const pad = (n) => String(n).padStart(2, '0');
  const yy = String(stamp.getUTCFullYear()).slice(-2);
  const reasonStamp = `${pad(stamp.getUTCDate())}/${pad(stamp.getUTCMonth() + 1)}/${yy} ${pad(stamp.getUTCHours())}:${pad(stamp.getUTCMinutes())}:00`;
  const consoleBase = `https://${AWS_REGION}.console.aws.amazon.com/cloudwatch/home?region=${AWS_REGION}`;
  return {
    alarmName: ALARM_NAME,
    alarmDescription: '7NOW checkout API returned HTTP 5xx (order placement failures) in prod',
    region: AWS_REGION,
    regionLabel: AWS_REGION_LABEL,
    accountId: AWS_ACCOUNT_ID,
    previousState: 'OK',
    reason: `Threshold Crossed: 1 datapoint [1.0 (${reasonStamp})] was greater than or equal to the threshold (1.0).`,
    timestamp: stamp.toISOString(),
    namespace: '7NOW/CheckoutAPI',
    metricName: '5XXError',
    dimensions: { ServiceName: SERVICE, Environment: 'prod', Route: ROUTE },
    period: 60,
    statistic: 'Sum',
    unit: 'Count',
    threshold: 1,
    comparison: 'GreaterThanOrEqualToThreshold',
    evaluationPeriods: 1,
    datapoints: 1,
    treatMissingData: 'notBreaching',
    snsTopic: '7now-oncall-alerts',
    logGroup: LOG_GROUP,
    alarmUrl: `${consoleBase}#alarmsV2:alarm/${ALARM_NAME}`,
    logsUrl: `${consoleBase}#logsV2:log-groups/log-group/${encodeURIComponent(LOG_GROUP).replace(/%/g, '$25')}`,
  };
}

function reportFailure(error, context) {
  const alarm = buildAlarm(Date.now());
  Sentry.captureException(error, {
    tags: {
      route: ROUTE,
      service: SERVICE,
      customer: CUSTOMER,
      monitor: 'cloudwatch',
      alarm: ALARM_NAME,
      alert_path: 'instant',
    },
    extra: context,
  });
  logger.info('Posting alert and triggering Devin', { service: SERVICE, alarm: ALARM_NAME, ...context });
  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: alarm.alarmUrl,
    culprit: 'app/services/verticals/7eleven.js — packLine',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: context.devinUserId,
    devinEmail: context.devinEmail,
    devinOrgId: context.devinOrgId,
    service: SERVICE,
    verticalLabel: '7NOW Checkout',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: CUSTOMER,
    locale: 'en-cloudwatch',
    cloudwatch: alarm,
    level: 'error',
    platform: 'node',
    environment: 'prod',
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'monitor', value: 'cloudwatch' },
      { key: 'alarm', value: ALARM_NAME },
    ],
    extra: {
      orderId: context.orderId,
      items: context.items,
      temps: context.temps,
    },
  }).catch((err) => {
    logger.error('Failed to create Devin session for 7NOW checkout error', {
      error: err.message,
      orderId: context.orderId,
    });
  });
}

/**
 * Place a 7NOW delivery order.
 */
async function placeOrder(data = {}) {
  const lines = normalizeItems(data.items);
  const address = normalizeAddress(data.address);
  const orderId = `7N-${Date.now().toString(36).toUpperCase()}`;
  const temps = [...new Set(lines.map((l) => l.product.temp))];

  logger.info('7NOW order placement started', {
    orderId, lineCount: lines.length, temps, address,
  });

  try {
    const packed = lines.map(packLine);
    const subtotal = round2(packed.reduce((sum, line) => sum + line.lineTotal, 0));
    const smallBasketFee = subtotal < SMALL_BASKET_MIN ? SMALL_BASKET_FEE : 0;
    const serviceFee = round2(subtotal * SERVICE_FEE_RATE);
    const tax = round2(subtotal * TAX_RATE);
    const total = round2(subtotal + DELIVERY_FEE + serviceFee + smallBasketFee + tax);
    const bags = [...new Set(packed.map((line) => line.handling))];
    const etaMinutes = packed.some((line) => line.bagType === 'insulated-hot') ? 25 : 30;

    logger.info('7NOW order placed', { orderId, total, bags });
    return {
      success: true,
      orderId,
      address,
      items: packed,
      bags,
      subtotal,
      deliveryFee: DELIVERY_FEE,
      serviceFee,
      smallBasketFee,
      tax,
      total,
      etaMinutes,
      message: `Order placed — arriving in about ${etaMinutes} minutes`,
    };
  } catch (error) {
    logger.error('7NOW order placement failed', {
      orderId, error: error.message, errorType: error.name, temps,
    });
    reportFailure(error, {
      orderId,
      items: lines.map((l) => ({ id: l.product.id, qty: l.qty, temp: l.product.temp })),
      temps,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
    });
    throw error;
  }
}

module.exports = {
  placeOrder,
  buildAlarm,
  CATALOG,
  SHELVES,
  CATEGORIES,
  OFFERS,
  BRANDS,
  HANDLING_RULES,
  DELIVERY_FEE,
  SERVICE_FEE_RATE,
  TAX_RATE,
  SMALL_BASKET_MIN,
  SMALL_BASKET_FEE,
  MAX_LINE_QTY,
  MAX_CART_LINES,
  ADDRESS_PLACEHOLDER,
  SERVICE,
  ROUTE,
  ALARM_NAME,
};
