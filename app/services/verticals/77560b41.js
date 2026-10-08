const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { postThreadReply } = require('../slack');
const { getCustomerConfig } = require('../../../config/customers');

const SERVICE = 'customer-77560b41-checkout';
const ROUTE = '/api/77560b41/checkout';
const CULPRIT = 'app/services/verticals/77560b41.js — applySubstitutions';
const SLACK_MEMBER_ID = process.env.C77560B41_SLACK_MEMBER_ID || '';
const INCIDENT_WINDOW_MS = 30 * 60 * 1000;

const REGIONS = {
  'nj-pa-ny': {
    id: 'nj-pa-ny',
    label: 'NJ / PA / NY',
    warehouseId: 'WH-NJ-DELANCO',
    timeZone: 'America/New_York',
    cutoffHour: 20,
  },
  chicago: {
    id: 'chicago',
    label: 'Chicago',
    warehouseId: 'WH-IL-ROMEOVILLE',
    timeZone: 'America/Chicago',
    cutoffHour: 20,
  },
  texas: {
    id: 'texas',
    label: 'Texas',
    warehouseId: 'WH-TX-DALLAS',
    timeZone: 'America/Chicago',
    cutoffHour: 20,
  },
};

const CATALOG = [
  { sku: 'honeycrisp-apples', name: 'Honeycrisp Apples', emoji: '🍎', image: '/verticals/77560b41/img/honeycrisp-apples.jpg', unit: '3 lb bag', priceCents: 699, category: 'produce' },
  { sku: 'gala-apples', name: 'Gala Apples', emoji: '🍏', image: '/verticals/77560b41/img/gala-apples.jpg', unit: '3 lb bag', priceCents: 549, category: 'produce' },
  { sku: 'rainbow-carrots', name: 'Rainbow Carrots', emoji: '🥕', image: '/verticals/77560b41/img/rainbow-carrots.jpg', unit: '1 lb bunch', priceCents: 399, category: 'produce' },
  { sku: 'baby-spinach', name: 'Baby Spinach', emoji: '🥬', image: '/verticals/77560b41/img/baby-spinach.jpg', unit: '5 oz clamshell', priceCents: 349, category: 'produce' },
  { sku: 'avocados', name: 'Hass Avocados', emoji: '🥑', image: '/verticals/77560b41/img/avocados.jpg', unit: '4 count', priceCents: 599, category: 'produce' },
  { sku: 'strawberries', name: 'Organic Strawberries', emoji: '🍓', image: '/verticals/77560b41/img/strawberries.jpg', unit: '1 lb carton', priceCents: 649, category: 'produce' },
  { sku: 'sweet-potatoes', name: 'Sweet Potatoes', emoji: '🍠', image: '/verticals/77560b41/img/sweet-potatoes.jpg', unit: '2 lb bag', priceCents: 429, category: 'produce' },
  { sku: 'broccoli', name: 'Broccoli Crowns', emoji: '🥦', image: '/verticals/77560b41/img/broccoli.jpg', unit: '2 count', priceCents: 379, category: 'produce' },
  { sku: 'organic-eggs', name: 'Pasture-Raised Eggs', emoji: '🥚', image: '/verticals/77560b41/img/organic-eggs.jpg', unit: 'dozen', priceCents: 699, category: 'protein' },
  { sku: 'chicken-breast', name: 'Organic Chicken Breast', emoji: '🍗', image: '/verticals/77560b41/img/chicken-breast.jpg', unit: '1 lb pack', priceCents: 1099, category: 'protein' },
  { sku: 'ground-turkey', name: 'Ground Turkey', emoji: '🦃', image: '/verticals/77560b41/img/ground-turkey.jpg', unit: '1 lb pack', priceCents: 899, category: 'protein' },
  { sku: 'wild-salmon', name: 'Wild-Caught Salmon', emoji: '🐟', image: '/verticals/77560b41/img/wild-salmon.jpg', unit: '12 oz pack', priceCents: 1299, category: 'protein' },
];

const CATALOG_BY_SKU = Object.fromEntries(CATALOG.map((item) => [item.sku, item]));

const INVENTORY = {
  'WH-NJ-DELANCO': {
    'honeycrisp-apples': { onHand: 72, avgDailyUnits: 18 },
    'gala-apples': { onHand: 64, avgDailyUnits: 16 },
    'rainbow-carrots': { onHand: 56, avgDailyUnits: 14 },
    'baby-spinach': { onHand: 8, avgDailyUnits: 5 },
    avocados: { onHand: 48, avgDailyUnits: 12 },
    strawberries: { onHand: 36, avgDailyUnits: 9 },
    'sweet-potatoes': { onHand: 7, avgDailyUnits: 4 },
    broccoli: { onHand: 50, avgDailyUnits: 10 },
    'organic-eggs': { onHand: 60, avgDailyUnits: 15 },
    'chicken-breast': { onHand: 5, avgDailyUnits: 3 },
    'ground-turkey': { onHand: 32, avgDailyUnits: 8 },
    'wild-salmon': { onHand: 4, avgDailyUnits: 2 },
  },
  'WH-IL-ROMEOVILLE': {
    'honeycrisp-apples': { onHand: 0, avgDailyUnits: 14 },
    'gala-apples': { onHand: 52, avgDailyUnits: 13 },
    'rainbow-carrots': { onHand: 5, avgDailyUnits: 3 },
    'baby-spinach': { onHand: 32, avgDailyUnits: 8 },
    avocados: { onHand: 3, avgDailyUnits: 2 },
    strawberries: { onHand: 15, avgDailyUnits: 8 },
    'sweet-potatoes': { onHand: 40, avgDailyUnits: 10 },
    broccoli: { onHand: 2, avgDailyUnits: 2 },
    'organic-eggs': { onHand: 44, avgDailyUnits: 11 },
    'chicken-breast': { onHand: 18, avgDailyUnits: 9 },
    'ground-turkey': { onHand: 6, avgDailyUnits: 4 },
    'wild-salmon': { onHand: 36, avgDailyUnits: 6 },
  },
  'WH-TX-DALLAS': {
    'honeycrisp-apples': { onHand: 32, avgDailyUnits: 8 },
    'gala-apples': { onHand: 40, avgDailyUnits: 10 },
    'rainbow-carrots': { onHand: 32, avgDailyUnits: 8 },
    'baby-spinach': { onHand: 3, avgDailyUnits: 2 },
    avocados: { onHand: 48, avgDailyUnits: 12 },
    strawberries: { onHand: 6, avgDailyUnits: 3 },
    'sweet-potatoes': { onHand: 5, avgDailyUnits: 3 },
    broccoli: { onHand: 40, avgDailyUnits: 8 },
    'organic-eggs': { onHand: 4, avgDailyUnits: 2 },
    'chicken-breast': { onHand: 48, avgDailyUnits: 12 },
    'ground-turkey': { onHand: 35, avgDailyUnits: 7 },
    'wild-salmon': { onHand: 7, avgDailyUnits: 4 },
  },
};

const SUBSTITUTIONS = {
  'WH-NJ-DELANCO': {},
  'WH-IL-ROMEOVILLE': { 'honeycrisp-apples': 'gala-apples' },
  'WH-TX-DALLAS': {},
};

// Substitution rules are maintained centrally at the primary DC.
const PRIMARY_WAREHOUSE_ID = 'WH-NJ-DELANCO';

const ROUTES = [
  { id: 'NJ-01', region: 'nj-pa-ny', driver: 'Maya R. · Van 12', stops: 34, onTimePct: 98, status: 'On route' },
  { id: 'NJ-02', region: 'nj-pa-ny', driver: 'Andre K. · Van 18', stops: 29, onTimePct: 96, status: 'On route' },
  { id: 'NJ-03', region: 'nj-pa-ny', driver: 'Sofia M. · Van 07', stops: 31, onTimePct: 94, status: 'Loading' },
  { id: 'CHI-01', region: 'chicago', driver: 'Eli T. · Van 22', stops: 27, onTimePct: 97, status: 'On route' },
  { id: 'CHI-02', region: 'chicago', driver: 'Nia B. · Van 31', stops: 24, onTimePct: 92, status: 'On route' },
  { id: 'CHI-03', region: 'chicago', driver: 'Omar J. · Van 04', stops: 30, onTimePct: 95, status: 'Loading' },
  { id: 'TX-01', region: 'texas', driver: 'Luz P. · Van 16', stops: 26, onTimePct: 96, status: 'On route' },
  { id: 'TX-02', region: 'texas', driver: 'Caleb W. · Van 25', stops: 32, onTimePct: 93, status: 'Loading' },
];

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'Chicago checkouts are returning 500. Find the root cause and the commit that introduced it (use git log/blame).',
  'Quantify customer impact today from the seeded order log (`ORDERS_TODAY`, `checkout_failed`).',
  'Post the RCA (what broke, file + commit, orders affected) in the Slack thread.',
  'Make the smallest fix while preserving the response shape and substitution behaviour for every region, and add a regression test.',
  'Run `npx jest tests/77560b41-checkout.test.js --runInBand` and `npm run lint`.',
  'Open a PR against `main`; do not merge it.',
  '',
  '- Service: `app/services/verticals/77560b41.js`',
  '- Route: `app/routes/verticals/77560b41.js`',
  '- Storefront: `app/public/verticals/77560b41.html` (served at `/misfits`)',
  '- Ops page: `app/public/verticals/77560b41/ops.html` (served at `/misfits/ops`)',
  '- Test: `tests/77560b41-checkout.test.js`',
].join('\n');

let seededOrdersDate = new Date().toISOString().slice(0, 10);
const ORDERS_TODAY = buildSeededOrders(seededOrdersDate);
const liveOrders = [];
const incidents = new Map();

function localDateParts(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return { year: Number(values.year), month: Number(values.month), day: Number(values.day) };
}

function dateKey({ year, month, day }) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function shiftDate(parts, amount) {
  const value = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + amount));
  return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
}

function dateAtZone(date, time, timeZone) {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const desired = Date.UTC(year, month - 1, day, hour, minute);
  let instant = desired;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(new Date(instant));
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const rendered = Date.UTC(
      Number(values.year),
      Number(values.month) - 1,
      Number(values.day),
      Number(values.hour),
      Number(values.minute),
    );
    instant += desired - rendered;
  }
  return new Date(instant);
}

function getDeliveryWindows(regionId, now = new Date()) {
  const region = REGIONS[regionId];
  if (!region) return [];

  const windows = [];
  let candidate = shiftDate(localDateParts(now, region.timeZone), 1);
  while (windows.length < 9) {
    const day = dateKey(candidate);
    const cutoff = dateAtZone(dateKey(shiftDate(candidate, -1)), `${String(region.cutoffHour).padStart(2, '0')}:00`, region.timeZone);
    if (now.getTime() < cutoff.getTime()) {
      const formattedDay = new Intl.DateTimeFormat('en-US', {
        timeZone: region.timeZone,
        weekday: 'short',
        month: 'short',
        day: 'numeric',
      }).format(dateAtZone(day, '12:00', region.timeZone));
      for (const window of [
        { id: 'morning', label: '8:00 AM – 12:00 PM', start: '08:00', end: '12:00' },
        { id: 'afternoon', label: '12:00 PM – 4:00 PM', start: '12:00', end: '16:00' },
        { id: 'evening', label: '4:00 PM – 8:00 PM', start: '16:00', end: '20:00' },
      ]) {
        windows.push({
          id: `${region.id}-${day}-${window.id}`,
          date: day,
          dayLabel: formattedDay,
          label: window.label,
          cutoff: cutoff.toISOString(),
          cutoffLabel: `Order by ${region.cutoffHour}:00 local time the evening before`,
        });
      }
    }
    candidate = shiftDate(candidate, 1);
  }
  return windows;
}

function stockStatus(warehouseId, sku) {
  const record = INVENTORY[warehouseId][sku];
  if (!record || record.onHand === 0) return 'out_of_stock';
  if (record.onHand / record.avgDailyUnits <= 3) return 'low';
  return 'in_stock';
}

function getCatalog(regionId) {
  return {
    regions: Object.values(REGIONS).map(({ id, label, warehouseId, timeZone }) => ({
      id, label, warehouseId, timeZone,
    })),
    catalog: CATALOG.map((item) => {
      const stockStatusByRegion = Object.fromEntries(
        Object.values(REGIONS).map((region) => [region.id, stockStatus(region.warehouseId, item.sku)]),
      );
      return {
        ...item,
        stockStatusByRegion,
        ...(regionId ? { stockStatus: stockStatusByRegion[regionId] } : {}),
      };
    }),
  };
}

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.status = 400;
  error.code = code;
  return error;
}

function validateCheckout(data) {
  const region = REGIONS[data.region];
  if (!region) throw validationError(`Unknown delivery region: ${data.region}`, 'UNKNOWN_REGION');
  if (!Array.isArray(data.items) || data.items.length === 0) {
    throw validationError('Add at least one item to your box.', 'EMPTY_BOX');
  }
  if (data.items.length > 30) {
    throw validationError('A box can contain no more than 30 items.', 'TOO_MANY_ITEMS');
  }
  for (const entry of data.items) {
    if (!entry || !CATALOG_BY_SKU[entry.sku]) {
      throw validationError(`Unknown catalog item: ${entry && entry.sku}`, 'UNKNOWN_SKU');
    }
    const qty = Number(entry.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 20) {
      throw validationError(`Quantity for ${entry.sku} must be between 1 and 20.`, 'INVALID_QUANTITY');
    }
  }
  const deliveryWindow = getDeliveryWindows(data.region)
    .find((window) => window.id === data.deliveryWindowId);
  if (!deliveryWindow) {
    throw validationError('Choose an available delivery window.', 'UNKNOWN_DELIVERY_WINDOW');
  }
  return { region, deliveryWindow };
}

function resolveSubstitute(sku) {
  const substitutions = SUBSTITUTIONS[PRIMARY_WAREHOUSE_ID] || {};
  return CATALOG_BY_SKU[substitutions[sku]];
}

function applySubstitutions(items, warehouseId) {
  const inventory = INVENTORY[warehouseId];
  return items.map(({ sku, qty }) => {
    const item = CATALOG_BY_SKU[sku];
    if (inventory[sku].onHand === 0) {
      const substitute = resolveSubstitute(sku);
      return {
        sku: substitute.sku,
        name: substitute.name,
        emoji: substitute.emoji,
        image: substitute.image,
        qty,
        unitPriceCents: substitute.priceCents,
        substitutedFrom: sku,
      };
    }
    return {
      sku,
      name: item.name,
      emoji: item.emoji,
      image: item.image,
      qty,
      unitPriceCents: item.priceCents,
    };
  });
}

function groupIncident({ errorClass, culprit, region, now = Date.now() }) {
  const key = `${errorClass}:${culprit}:${region}`;
  const current = incidents.get(key);
  if (current && now - current.startedAt < INCIDENT_WINDOW_MS) {
    current.occurrences += 1;
    return { key, isNew: false, occurrenceCount: current.occurrences, incident: current };
  }
  const incident = { startedAt: now, occurrences: 1, threadTs: null };
  incidents.set(key, incident);
  return { key, isNew: true, occurrenceCount: 1, incident };
}

function resetIncidentState() {
  incidents.clear();
  liveOrders.length = 0;
}

function failureAlertPayload(error, context) {
  return {
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: CULPRIT,
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: context.devinUserId,
    devinOrgId: context.devinOrgId,
    devinEmail: context.devinEmail,
    ...(!context.devinEmail && SLACK_MEMBER_ID ? { slackMemberId: SLACK_MEMBER_ID } : {}),
    ...(SLACK_MEMBER_ID ? { slackMemberIdFallback: SLACK_MEMBER_ID } : {}),
    service: SERVICE,
    verticalLabel: 'Misfits Market Checkout',
    promptAppendix: REMEDIATION_DIRECTIVE,
    customer: '77560b41',
    level: 'error',
    platform: 'node',
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'region', value: context.region },
      { key: 'warehouse', value: context.warehouseId },
    ],
    extra: {
      orderId: context.orderId,
      region: context.region,
      warehouseId: context.warehouseId,
      skus: context.skus,
      requestId: context.requestId,
    },
  };
}

function reportCheckoutFailure(error, context) {
  const details = {
    route: ROUTE,
    errorClass: error.name || 'Error',
    region: context.region,
    warehouse: context.warehouseId,
    skus: context.skus,
  };
  logger.error('Misfits Market checkout failed', {
    ...details,
    error: error.message,
    orderId: context.orderId,
    requestId: context.requestId,
  });
  incrementMetric('misfits_checkout.failure', details);
  Sentry.captureException(error, {
    tags: {
      route: ROUTE,
      service: SERVICE,
      region: context.region,
      warehouse: context.warehouseId,
      alert_path: 'instant',
    },
    extra: {
      orderId: context.orderId,
      requestId: context.requestId,
      skus: context.skus,
    },
  });

  const grouping = groupIncident({
    errorClass: error.name || 'Error',
    culprit: CULPRIT,
    region: context.region,
    now: context.now,
  });
  if (grouping.isNew) {
    const alert = failureAlertPayload(error, context);
    createSessionAndAlert(alert)
      .then((result) => {
        if (!result) {
          if (incidents.get(grouping.key) === grouping.incident) incidents.delete(grouping.key);
          return;
        }
        grouping.incident.threadTs = result && result.threadTs ? result.threadTs : null;
      })
      .catch((alertError) => {
        if (incidents.get(grouping.key) === grouping.incident) incidents.delete(grouping.key);
        logger.error('Failed to create Devin session for Misfits Market checkout error', {
          error: alertError.message,
          orderId: context.orderId,
        });
      });
  } else if (grouping.incident.threadTs && process.env.SLACK_BOT_TOKEN) {
    const config = getCustomerConfig('77560b41');
    const channel = config.slackChannelId || process.env.SLACK_CHANNEL_ID;
    if (channel) {
      postThreadReply(
        process.env.SLACK_BOT_TOKEN,
        channel,
        grouping.incident.threadTs,
        `Repeat occurrence #${grouping.occurrenceCount} grouped into this incident — region ${context.region}, order ${context.orderId}`,
      ).catch((replyError) => {
        logger.error('Failed to post Misfits Market incident repeat to Slack', {
          error: replyError.message,
          orderId: context.orderId,
        });
      });
    } else {
      logger.info('Misfits Market checkout grouped into existing incident', {
        region: context.region,
        orderId: context.orderId,
        occurrenceCount: grouping.occurrenceCount,
      });
    }
  } else {
    logger.info('Misfits Market checkout grouped into existing incident', {
      region: context.region,
      orderId: context.orderId,
      occurrenceCount: grouping.occurrenceCount,
    });
  }
}

function createOrderId() {
  return `MM-${uuidv4().slice(0, 8).toUpperCase()}`;
}

async function checkout(data, options = {}) {
  const { region, deliveryWindow } = validateCheckout(data);
  const orderId = createOrderId();
  const skus = data.items.map((item) => item.sku);
  const now = options.now === undefined ? new Date() : new Date(options.now);
  try {
    const items = applySubstitutions(data.items, region.warehouseId);
    const subtotalCents = items.reduce((sum, item) => sum + item.unitPriceCents * item.qty, 0);
    const totals = {
      subtotalCents,
      deliveryCents: 599,
      totalCents: subtotalCents + 599,
      currency: 'USD',
    };
    const order = {
      orderId,
      region: region.id,
      items,
      deliveryWindow,
      totals,
      status: 'confirmed',
      placedAt: now.toISOString(),
    };
    liveOrders.push(order);
    return { success: true, orderId, region: region.id, items, deliveryWindow, totals };
  } catch (error) {
    liveOrders.push({
      id: orderId,
      region: region.id,
      items: data.items.map(({ sku, qty }) => ({ sku, qty })),
      status: 'checkout_failed',
      placedAt: now.toISOString(),
    });
    reportCheckoutFailure(error, {
      region: region.id,
      warehouseId: region.warehouseId,
      skus,
      orderId,
      requestId: options.requestId,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      now: now.getTime(),
    });
    throw error;
  }
}

function seededHash(value) {
  let hash = 2166136261;
  for (const character of value) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function buildSeededOrders(today = new Date().toISOString().slice(0, 10)) {
  const regionIds = Object.keys(REGIONS);
  const skus = CATALOG.map((item) => item.sku);
  return Array.from({ length: 120 }, (_, index) => {
    const region = regionIds[Math.floor(index / 40)];
    const orderNumber = (index % 40) + 1;
    const hash = seededHash(`77560b41:${today}:${index}`);
    const includesHoneycrisp = region === 'chicago' && orderNumber <= 22;
    const itemSkus = [
      ...(includesHoneycrisp ? ['honeycrisp-apples'] : []),
      ...[skus[hash % skus.length], skus[(hash >>> 5) % skus.length]].map((sku) => (
        region === 'chicago' && !includesHoneycrisp && sku === 'honeycrisp-apples' ? 'gala-apples' : sku
      )),
    ];
    return {
      id: `MM-${region.toUpperCase()}-${String(orderNumber).padStart(3, '0')}`,
      region,
      placedAt: `${today}T${String(7 + (orderNumber % 12)).padStart(2, '0')}:${String((orderNumber * 7) % 60).padStart(2, '0')}:00`,
      items: [...new Set(itemSkus)].map((sku, itemIndex) => ({ sku, qty: 1 + ((hash >>> (itemIndex * 3)) % 3) })),
      status: includesHoneycrisp ? 'checkout_failed' : 'confirmed',
    };
  });
}

function getSeededOrders(today) {
  if (today !== seededOrdersDate) {
    seededOrdersDate = today;
    ORDERS_TODAY.splice(0, ORDERS_TODAY.length, ...buildSeededOrders(today));
  }
  return ORDERS_TODAY;
}

function getOpsSummary(now = new Date()) {
  const today = new Date(now).toISOString().slice(0, 10);
  const seededOrders = getSeededOrders(today);
  const todayLiveOrders = liveOrders.filter((order) => order.placedAt.slice(0, 10) === today);
  const wallClockToday = new Date().toISOString().slice(0, 10);
  const retainedLiveOrders = liveOrders.filter((order) => order.placedAt.slice(0, 10) >= wallClockToday);
  liveOrders.splice(0, liveOrders.length, ...retainedLiveOrders);
  const orders = [...seededOrders, ...todayLiveOrders];
  const ordersByRegion = Object.values(REGIONS).map((region) => {
    const regionOrders = orders.filter((order) => order.region === region.id);
    return {
      region: region.id,
      label: region.label,
      confirmed: regionOrders.filter((order) => order.status === 'confirmed').length,
      checkout_failed: regionOrders.filter((order) => order.status === 'checkout_failed').length,
    };
  });
  const lowStock = Object.entries(INVENTORY).map(([warehouseId, inventory]) => ({
    warehouseId,
    items: Object.entries(inventory)
      .map(([sku, stock]) => ({ ...CATALOG_BY_SKU[sku], ...stock }))
      .sort((a, b) => a.onHand - b.onHand)
      .slice(0, 5),
  }));
  const onTimePct = Math.round(ROUTES.reduce((sum, route) => sum + route.onTimePct, 0) / ROUTES.length);
  return {
    date: today,
    kpis: {
      ordersToday: orders.length,
      failedCheckouts: orders.filter((order) => order.status === 'checkout_failed').length,
      onTimePct,
    },
    ordersByRegion,
    lowStock,
    routes: ROUTES,
  };
}

module.exports = {
  REGIONS,
  CATALOG,
  INVENTORY,
  SUBSTITUTIONS,
  ROUTES,
  ORDERS_TODAY,
  REMEDIATION_DIRECTIVE,
  getCatalog,
  getDeliveryWindows,
  checkout,
  getOpsSummary,
  applySubstitutions,
  groupIncident,
  reportCheckoutFailure,
  failureAlertPayload,
  resetIncidentState,
};
