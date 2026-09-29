const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { resolveSourcing } = require('./d3e3804d-fulfillment');

const SERVICE = 'customer-d3e3804d-checkout';
const ROUTE = '/api/d3e3804d/checkout';
const IMG = 'https://n.nordstrommedia.com/it/';

const CATALOG = [
  { sku: '8104772', brand: 'adidas', name: 'Gazelle Indoor Sneaker', price: 120, was: null, color: 'Wild Brown/Cream White', size: '9', image: `${IMG}684fed87-3dc3-4ada-a4c3-a24d8800b10a.jpeg`, badge: 'Popular', reviews: 24563, rating: 4.5 },
  { sku: '7966031', brand: 'DAZE', name: 'Farout Wide Leg Jeans', price: 39.20, was: 98, color: 'Ohh La La', size: '27', image: `${IMG}292f1d0c-a6d3-4ded-b638-a146ad94bd0e.jpeg`, badge: 'New Markdown', reviews: 10, rating: 4 },
  { sku: '8230557', brand: 'Bombas', name: 'Assorted 3-Pack Marl Quarter Crew Socks', price: 22.50, was: 45, color: 'Brown Multi', size: 'M', image: `${IMG}2f5cd84d-7188-4faf-928f-c81721a21189.jpeg`, badge: 'New Markdown', reviews: 5, rating: 5 },
  { sku: '7753218', brand: 'Vuori', name: 'AllTheForm™ Fitness Jacket', price: 49.99, was: 128, color: 'Black', size: 'S', image: `${IMG}5d67eb8a-f0ec-40ac-8a90-c1deeaf08e19.jpeg`, badge: 'New Markdown', reviews: 3, rating: 4.5 },
  { sku: '8011945', brand: 'CeCe', name: 'Puff Sleeve Button-Up Shirt', price: 27.60, was: 69, color: 'Rich Black', size: 'M', image: `${IMG}e40a1c19-9a2c-4e96-8e0c-2a711fe901e5.jpeg`, badge: 'New Markdown', reviews: 84, rating: 4 },
  { sku: '7899410', brand: 'Birkenstock', name: 'Essentials - Gizeh Flip Flop', price: 29.96, was: 49.95, color: 'Black', size: '38', image: `${IMG}79d808f0-e549-4ffa-a170-69d81f538a23.jpeg`, badge: 'New Markdown', reviews: 406, rating: 4.5 },
  { sku: '8154093', brand: 'Elwood', name: 'Organic Cotton Hoodie', price: 37.50, was: 75, color: 'Heather Grey', size: 'L', image: `${IMG}1429f533-299d-46d1-b940-d77c581ad877.jpeg`, badge: 'New Markdown', reviews: 2, rating: 4 },
  { sku: '7988126', brand: 'Bernardo', name: 'Plaid Bomber Jacket', price: 89.99, was: 220, color: 'Camel Plaid', size: 'M', image: `${IMG}c74acdcd-0306-4f4c-bc84-1d3f80db96eb.jpeg`, badge: 'New Markdown', reviews: 1, rating: 5 },
  { sku: '8067734', brand: 'KUT from the Kloth', name: 'Kit High Waist Ankle Baggy Straight Leg Jeans', price: 38.15, was: 109, color: 'Committed', size: '6', image: `${IMG}6feec6b6-d8cf-4e50-ac4f-1d3a2b530266.jpeg`, badge: 'New Markdown', reviews: 4, rating: 4 },
  { sku: '8192205', brand: 'Blondo', name: 'Alexis Waterproof Knee High Boot', price: 143.98, was: 239.95, color: 'Black Leather', size: '8', image: `${IMG}80868421-ec5a-43df-9723-d8f2126dfac9.jpeg`, badge: 'New Markdown', reviews: 7, rating: 4.5 },
  { sku: '7921583', brand: 'Open Edit', name: 'Icon Twill Relaxed Blazer', price: 99.50, was: null, color: 'Black', size: 'M', image: `${IMG}98a9fb9b-ecc3-456c-a84f-403b7f524c5f.jpeg`, badge: 'Popular', reviews: 118, rating: 4.5 },
  { sku: '8140667', brand: 'Madewell', name: 'Cary Slouchy High Rise Wide Leg Jeans', price: 138, was: null, color: 'Cadwell Wash', size: '28', image: `${IMG}af991aa8-c0b5-4b4c-be1a-11911b89b530.jpeg`, badge: 'Popular', reviews: 42, rating: 4 },
];

const STARTER_BAG = [
  { sku: '8104772', qty: 1 },
  { sku: '7966031', qty: 1 },
  { sku: '8230557', qty: 2 },
  { sku: '7753218', qty: 1 },
];

const DESTINATIONS = {
  94115: { city: 'San Francisco', state: 'CA', zone: 1, taxRate: 0.08625 },
  10001: { city: 'New York', state: 'NY', zone: 5, taxRate: 0.08875 },
  98101: { city: 'Seattle', state: 'WA', zone: 2, taxRate: 0.1035 },
};

const FREE_SHIPPING = { method: 'standard', label: 'Free Standard Shipping', cost: 0 };

function getCatalog() {
  return { products: CATALOG, bag: STARTER_BAG };
}

function priceLines(items) {
  return items.map((item) => {
    const product = CATALOG.find((p) => p.sku === String(item.sku));
    if (!product) {
      const err = new Error(`Item ${item.sku} is no longer available.`);
      err.name = 'ValidationError';
      err.code = 'ITEM_UNAVAILABLE';
      err.statusCode = 400;
      throw err;
    }
    const qty = Number(item.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 10) {
      const err = new Error(`Quantity for item ${product.sku} must be between 1 and 10.`);
      err.name = 'ValidationError';
      err.code = 'INVALID_QUANTITY';
      err.statusCode = 400;
      throw err;
    }
    return {
      sku: product.sku,
      brand: product.brand,
      name: product.name,
      color: product.color,
      size: product.size,
      unitPrice: product.price,
      qty,
      lineTotal: Math.round(product.price * qty * 100) / 100,
    };
  });
}

function planShipments(lines) {
  return lines.map((line) => ({ ...line, sourcing: resolveSourcing(line.sku) }));
}

function buildPackages(planned) {
  const byOrigin = new Map();
  planned.forEach((line) => {
    const key = line.sourcing.node.id;
    if (!byOrigin.has(key)) {
      byOrigin.set(key, {
        origin: key,
        node: line.sourcing.node,
        shipsFrom: line.sourcing.shipsFrom,
        leadDays: line.sourcing.leadDays,
        lines: [],
      });
    }
    const pkg = byOrigin.get(key);
    pkg.leadDays = Math.max(pkg.leadDays, line.sourcing.leadDays);
    pkg.lines.push({ sku: line.sku, qty: line.qty });
  });
  return [...byOrigin.values()];
}

function addBusinessDays(from, days) {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) left -= 1;
  }
  return d;
}

function quoteDelivery(packages, destination, now) {
  return packages.map((pkg) => {
    const transitDays = 1 + Math.abs(pkg.node.zone - destination.zone);
    const arrives = addBusinessDays(now, pkg.leadDays + transitDays);
    return {
      origin: pkg.origin,
      shipsFrom: pkg.shipsFrom,
      items: pkg.lines.reduce((n, l) => n + l.qty, 0),
      transitDays,
      estimatedArrival: arrives.toISOString().slice(0, 10),
    };
  });
}

function summarize(lines, destination) {
  const subtotal = Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;
  const tax = Math.round(subtotal * destination.taxRate * 100) / 100;
  return {
    itemCount: lines.reduce((n, l) => n + l.qty, 0),
    subtotal,
    shipping: FREE_SHIPPING.cost,
    shippingLabel: FREE_SHIPPING.label,
    estimatedTax: tax,
    total: Math.round((subtotal + tax + FREE_SHIPPING.cost) * 100) / 100,
  };
}

async function checkout(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const orderId = `N${Date.now().toString().slice(-6)}${requestId.replace(/-/g, '').slice(0, 6).toUpperCase()}`;
  const items = Array.isArray(data.items) ? data.items : [];
  const zip = Object.hasOwn(DESTINATIONS, String(data.zip)) ? String(data.zip) : '94115';
  const destination = DESTINATIONS[zip];

  logger.info('Starting bag checkout', {
    orderId, requestId, lines: items.length, zip, service: SERVICE, route: ROUTE,
  });

  try {
    if (!items.length) {
      const empty = new Error('Your Shopping Bag is empty.');
      empty.name = 'ValidationError';
      empty.code = 'EMPTY_BAG';
      empty.statusCode = 400;
      throw empty;
    }
    if (items.length > 20) {
      const tooMany = new Error('Your Shopping Bag can hold up to 20 items.');
      tooMany.name = 'ValidationError';
      tooMany.code = 'BAG_LIMIT';
      tooMany.statusCode = 400;
      throw tooMany;
    }

    await new Promise((resolve) => setTimeout(resolve, 120 + Math.random() * 160));

    const lines = priceLines(items);
    const planned = planShipments(lines);
    const packages = buildPackages(planned);
    const deliveries = quoteDelivery(packages, destination, new Date());
    const summary = summarize(lines, destination);

    const duration = Date.now() - startTime;
    incrementMetric('bag_checkout.success', { route: ROUTE, service: SERVICE });
    recordTiming('bag_checkout.latency', duration, { route: ROUTE });
    logger.info('Bag checkout completed', { orderId, requestId, durationMs: duration, packages: packages.length });

    return {
      orderId,
      shipTo: `${destination.city}, ${destination.state} ${zip}`,
      lines,
      deliveries,
      summary,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('bag_checkout.failure', { route: ROUTE, service: SERVICE, errorClass: error.name });
    recordTiming('bag_checkout.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('Bag checkout failed', {
      orderId, requestId, error: error.message, errorClass: error.name, durationMs: duration,
      skus: items.map((i) => i.sku), zip, service: SERVICE,
    });

    error.requestId = requestId;
    if (error.statusCode === 400) throw error;

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, customer: 'd3e3804d', alert_path: 'instant' },
      extra: { orderId, requestId, skus: items.map((i) => i.sku), zip },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/d3e3804d.js — checkout',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      customer: 'd3e3804d',
      service: SERVICE,
      verticalLabel: 'Nordstrom — Shopping Bag Checkout',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'ship_to', value: zip },
        { key: 'lines', value: String(items.length) },
      ],
      extra: {
        orderId,
        requestId,
        skus: items.map((i) => i.sku).join(','),
        zip,
        promptContext: 'Customers on nordstrom.com can open their Shopping Bag but every "Check Out" with this bag fails with a 500, so the order is never placed.',
      },
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
      promptAppendix: 'When you fix this, add regression tests that check out a bag containing every catalog SKU, and record a browser video of /d3e3804d showing the four-item Shopping Bag checking out successfully.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, requestId });
    });

    throw error;
  }
}

module.exports = {
  CATALOG,
  STARTER_BAG,
  getCatalog,
  checkout,
  priceLines,
  planShipments,
  buildPackages,
  quoteDelivery,
  summarize,
};
