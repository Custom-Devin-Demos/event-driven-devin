const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const meridian = require('./f63013c0-meridian');
const psp = require('./f63013c0-meridian-psp');
const orderStore = require('./f63013c0-orders');

const SERVICE = 'checkout-service';
const ROUTE = '/api/f63013c0/checkout';
const CUSTOMER = 'f63013c0';
const VERTICAL_LABEL = 'Ralph Lauren — Digital Flagship Checkout';
const GIFT_BOX_FEE = 5;
const ALERT_SUPPRESSION_MS = 10 * 60 * 1000;
const TRAFFIC_MAX_MS = 20 * 60 * 1000;

const CATALOG = [
  { sku: 'RL-KN-001', name: 'Cable-Knit Cashmere Sweater', price: 398, category: 'Knitwear', giftBoxEligible: true },
  { sku: 'RL-AC-014', name: 'Wool Scarf', price: 165, category: 'Accessories', giftBoxEligible: true },
  { sku: 'RL-SH-102', name: 'Custom Fit Oxford Shirt', price: 110, category: 'Shirts', giftBoxEligible: false },
  { sku: 'RL-OW-220', name: 'Quilted Barn Jacket', price: 498, category: 'Outerwear', giftBoxEligible: false },
  { sku: 'RL-AC-031', name: 'Leather Dress Belt', price: 125, category: 'Accessories', giftBoxEligible: false },
  { sku: 'RL-KN-044', name: 'Cotton Cable-Knit Sweater', price: 268, category: 'Knitwear', giftBoxEligible: false },
  { sku: 'RL-HM-301', name: 'Cashmere Throw Blanket', price: 595, category: 'Home', giftBoxEligible: true },
  { sku: 'RL-WM-118', name: 'Wool-Blend Tweed Blazer', price: 698, category: 'Tailoring', giftBoxEligible: true },
];

const ACCOUNT = {
  id: 'cus_claire',
  name: 'Claire Mallory',
  email: 'claire.mallory@example.com',
  address: {
    id: 'addr_claire_home',
    line1: '48 Commonwealth Avenue',
    line2: 'Apt 3',
    city: 'Boston',
    state: 'MA',
    zip: '02116',
  },
  card: {
    token: 'tok_claire_visa_4242',
    brand: 'Visa',
    last4: '4242',
    exp: '08/29',
  },
  cartId: 'bsk_claire',
};

const DEFAULT_BASKET = {
  cartId: 'bsk_claire',
  lines: [
    { sku: 'RL-KN-001', qty: 1 },
    { sku: 'RL-AC-014', qty: 1, giftBox: true },
  ],
};

// Carrefour grocery skin (/f63013c0/rb/carrefour): same checkout code path and
// PSP incident, with its own catalog, account, currency and alert label.
const CARREFOUR_CATALOG = [
  { sku: 'CF-FL-001', name: 'Fraises Gariguette', price: 4.99, category: 'Fruits et légumes', giftBoxEligible: true },
  { sku: 'CF-PO-014', name: 'Saumon fumé d’Écosse Label Rouge, 4 tranches', price: 6.49, category: 'Viandes et poissons', giftBoxEligible: true },
  { sku: 'CF-PA-102', name: 'Baguette de tradition française', price: 1.15, category: 'Pains et pâtisseries', giftBoxEligible: false },
  { sku: 'CF-CR-220', name: 'Lait demi-écrémé bio, pack 6 x 1 L', price: 7.14, category: 'Crèmerie', giftBoxEligible: false },
  { sku: 'CF-EP-031', name: 'Café en grains pur arabica', price: 12.49, category: 'Epicerie', giftBoxEligible: false },
  { sku: 'CF-BO-044', name: 'Jus d’orange 100% pressé', price: 3.29, category: 'Boissons', giftBoxEligible: false },
  { sku: 'CF-CR-301', name: 'Camembert de Normandie AOP au lait cru', price: 2.89, category: 'Crèmerie', giftBoxEligible: true },
  { sku: 'CF-VI-118', name: 'Poulet fermier jaune Label Rouge', price: 11.9, category: 'Viandes et poissons', giftBoxEligible: true },
];

const CARREFOUR_ACCOUNT = {
  id: 'cus_claire_fr',
  name: 'Claire Martin',
  email: 'claire.martin@example.fr',
  address: {
    id: 'addr_claire_paris',
    line1: '12 rue de Rivoli',
    line2: '',
    city: 'Paris',
    zip: '75004',
    country: 'France',
  },
  card: {
    token: 'tok_claire_fr_visa_4242',
    brand: 'Visa',
    last4: '4242',
    exp: '08/29',
  },
  cartId: 'bsk_claire_fr',
};

const CARREFOUR_BASKET = {
  cartId: 'bsk_claire_fr',
  lines: [
    { sku: 'CF-FL-001', qty: 1 },
    { sku: 'CF-PO-014', qty: 1, giftBox: true },
  ],
};

const BRANDS = {
  rl: {
    key: 'rl',
    label: VERTICAL_LABEL,
    site: 'ralphlauren.com',
    catalog: CATALOG,
    account: ACCOUNT,
    basket: DEFAULT_BASKET,
    giftBoxFee: GIFT_BOX_FEE,
    currency: 'USD',
    descriptor: 'RALPH LAUREN',
  },
  carrefour: {
    key: 'carrefour',
    label: 'Carrefour — Courses en ligne Checkout',
    site: 'carrefour.fr',
    catalog: CARREFOUR_CATALOG,
    account: CARREFOUR_ACCOUNT,
    basket: CARREFOUR_BASKET,
    giftBoxFee: 0.5,
    currency: 'EUR',
    descriptor: 'CARREFOUR',
  },
};

function brandOf(key) {
  return BRANDS[key] || BRANDS.rl;
}

function formatShipTo(addr) {
  if (addr.state) return `${addr.line1}${addr.line2 ? `, ${addr.line2}` : ''}, ${addr.city}, ${addr.state} ${addr.zip}`;
  return `${addr.line1}${addr.line2 ? `, ${addr.line2}` : ''}, ${addr.zip} ${addr.city}${addr.country ? `, ${addr.country}` : ''}`;
}

const SYNTHETIC_CUSTOMERS = Array.from({ length: 40 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return {
    customerId: `cus_syn_${n}`,
    cardToken: `tok_syn_${n}`,
    cartId: `bsk_syn_${n}`,
  };
});

const metrics = {
  attempts: [], // { t, success, customerId, total }
  incidentStartedAt: null,
  revenueAtRiskByCustomer: new Map(),
  affectedCustomers: new Set(),
  chatDrained: 0,
  lastAlertAt: null,
  alertFiredAt: null,
  ruleBreachSince: null,
  lastFailure: null,
  history: [], // { t, orderSuccessRate, ordersPerMinute }
};

const traffic = {
  running: false,
  interval: null,
  evalInterval: null,
  stopTimer: null,
};

function validationError(message, code) {
  const err = new Error(message);
  err.name = 'ValidationError';
  err.code = code || 'VALIDATION_ERROR';
  err.statusCode = 400;
  return err;
}

function getAccount() {
  return ACCOUNT;
}

function getCatalog(brandKey) {
  const brand = brandOf(brandKey);
  return {
    products: brand.catalog,
    customer: brand.account,
    basket: brand.basket,
    giftBoxFee: brand.giftBoxFee,
    currency: brand.currency,
    pspApiVersion: psp.getVersion(),
  };
}

function resolveCustomer(data, synthetic, brand = BRANDS.rl) {
  const account = brand.account;
  const customerId = data.customerId || (synthetic ? undefined : account.id);
  if (synthetic) {
    const syn = SYNTHETIC_CUSTOMERS.find((c) => c.customerId === customerId);
    if (!syn) throw validationError('Unknown customer.');
    if (data.paymentMethod === 'card' && data.cardToken !== syn.cardToken) {
      throw validationError('Saved card could not be found.', 'UNKNOWN_CARD');
    }
    return {
      id: syn.customerId,
      cartId: data.cartId || syn.cartId,
      cardToken: syn.cardToken,
      shipTo: 'Synthetic customer',
    };
  }
  if (customerId !== account.id) {
    throw validationError('Unknown customer.', 'UNKNOWN_CUSTOMER');
  }
  if (data.paymentMethod === 'card' && data.cardToken !== account.card.token) {
    throw validationError('Saved card could not be found.', 'UNKNOWN_CARD');
  }
  return {
    id: account.id,
    cartId: data.cartId || account.cartId,
    cardToken: account.card.token,
    shipTo: formatShipTo(account.address),
  };
}

function priceLines(lines, brand = BRANDS.rl) {
  if (!Array.isArray(lines) || !lines.length) {
    throw validationError('Your bag is empty.', 'EMPTY_BAG');
  }
  return lines.map((line) => {
    const product = brand.catalog.find((p) => p.sku === String(line.sku));
    if (!product) {
      throw validationError(`Item ${line.sku} is no longer available.`, 'ITEM_UNAVAILABLE');
    }
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 5) {
      throw validationError(`Quantity for ${product.name} must be between 1 and 5.`, 'INVALID_QUANTITY');
    }
    const giftBox = line.giftBox === true;
    if (giftBox && !product.giftBoxEligible) {
      throw validationError(`Gift boxing is not available for ${product.name}.`, 'GIFT_BOX_UNAVAILABLE');
    }
    const lineTotal = Math.round((product.price * qty + (giftBox ? brand.giftBoxFee : 0)) * 100) / 100;
    return {
      sku: product.sku,
      name: product.name,
      unitPrice: product.price,
      qty,
      giftBox,
      lineTotal,
    };
  });
}

function recordAttempt(success, customerId, total) {
  metrics.attempts.push({ t: Date.now(), success, customerId, total });
  if (!success) {
    if (!metrics.incidentStartedAt) metrics.incidentStartedAt = new Date().toISOString();
    metrics.affectedCustomers.add(customerId);
    if (!metrics.revenueAtRiskByCustomer.has(customerId)) {
      metrics.revenueAtRiskByCustomer.set(customerId, total);
    }
  }
}

function windowAttempts() {
  const cutoff = Date.now() - 60 * 1000;
  return metrics.attempts.filter((a) => a.t >= cutoff);
}

function getMetrics() {
  const attempts = windowAttempts();
  const attemptsCount = attempts.length;
  const successes = attempts.filter((a) => a.success).length;
  const orderSuccessRate = attemptsCount ? Math.round((successes / attemptsCount) * 10000) / 10000 : 1;

  const open = psp.listAuthorizations().filter((a) => a.status !== 'VOIDED' && !a.voidedAt);
  const chargedWithoutOrder = open.filter((a) => {
    const order = orderStore.get(a.reference);
    return order && order.status === 'pending';
  }).length;
  const byReference = new Map();
  open.forEach((a) => byReference.set(a.reference, (byReference.get(a.reference) || 0) + 1));
  const duplicateAuthorizations = [...byReference.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0);

  const customersAffected = metrics.affectedCustomers.size;
  const chatQueue = Math.max(0, Math.floor(customersAffected / 3) - metrics.chatDrained);

  let status = 'HEALTHY';
  if (attemptsCount >= 5 && orderSuccessRate < 0.9) status = 'INCIDENT';
  else if (orderSuccessRate < 0.95) status = 'DEGRADED';

  return {
    window: '60s',
    orderSuccessRate,
    ordersPerMinute: successes,
    revenueAtRisk: Math.round([...metrics.revenueAtRiskByCustomer.values()]
      .reduce((s, v) => s + v, 0) * 100) / 100,
    chargedWithoutOrder,
    duplicateAuthorizations,
    customersAffected,
    chatQueue,
    status,
    incidentStartedAt: metrics.incidentStartedAt,
    attempts: attemptsCount,
    pspApiVersion: psp.getVersion(),
    trafficRunning: traffic.running,
    alertFiredAt: metrics.alertFiredAt,
    flipAt: psp.getFlipAt(),
    history: metrics.history.slice(),
  };
}

function alertSuppressed() {
  return metrics.lastAlertAt && Date.now() - metrics.lastAlertAt < ALERT_SUPPRESSION_MS;
}

function buildPromptContext(error, brand = BRANDS.rl) {
  const m = getMetrics();
  const pct = Math.round(m.orderSuccessRate * 100);
  return `Success rate ${pct}% over last 60s (${m.attempts} attempts). Top error: ${error.message}. `
    + `Customers on ${brand.site} are being charged without an order being created — every "Try again" retry adds another pending card authorization.`;
}

const PROMPT_APPENDIX = 'Follow docs/f63013c0/RUNBOOK.md. The fix must satisfy docs/f63013c0/ENGINEERING_STANDARDS.md (schema validation + contract test from the vendor\'s published example, Idempotency-Key derived from the order reference, regression test). Keep the customer-facing PAYMENT_FAILED message unchanged; internally distinguish PSP_SCHEMA_MISMATCH. In the PR description include root cause, blast radius from GET /api/f63013c0/metrics, and a rollout note. After the fix is deployed, run `node scripts/f63013c0-reconcile-authorizations.js --base-url https://devindemos.com` and post its summary to the alert thread.';

function fireAlert(error, ctx) {
  const brand = brandOf(ctx.brand);
  metrics.lastAlertAt = Date.now();
  metrics.alertFiredAt = new Date().toISOString();

  Sentry.captureException(error, {
    tags: {
      route: ROUTE, service: SERVICE, customer: CUSTOMER, alert_path: ctx.alertPath, brand: brand.key,
    },
    extra: { orderId: ctx.orderId, requestId: ctx.requestId, apiVersion: ctx.apiVersion },
  });

  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/f63013c0.js — checkout',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: ctx.devinUserId,
    devinEmail: ctx.devinEmail,
    devinOrgId: ctx.devinOrgId,
    customer: CUSTOMER,
    service: SERVICE,
    verticalLabel: brand.label,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'psp_api_version', value: ctx.apiVersion || 'unknown' },
      { key: 'payment_method', value: ctx.paymentMethod || 'card' },
    ],
    extra: {
      orderId: ctx.orderId,
      requestId: ctx.requestId,
      apiVersion: ctx.apiVersion,
      responseKeys: (ctx.responseKeys || []).join(','),
      promptContext: buildPromptContext(error, brand),
      promptAppendix: PROMPT_APPENDIX,
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
    triggeredRule: ctx.alertPath === 'rule' ? 'order-success-rate' : '',
  }).catch((err) => {
    logger.error('Failed to trigger Devin session', { error: err.message, requestId: ctx.requestId });
  });
}

function evaluateAlertRule() {
  const m = getMetrics();
  const breached = m.attempts >= 10 && m.orderSuccessRate < 0.9;
  if (!breached) {
    metrics.ruleBreachSince = null;
    return;
  }
  if (!metrics.ruleBreachSince) metrics.ruleBreachSince = Date.now();
  if (Date.now() - metrics.ruleBreachSince >= 60 * 1000 && !alertSuppressed()) {
    const failure = metrics.lastFailure || {};
    const err = new Error(failure.message || 'Missing payment id in PSP response');
    fireAlert(err, {
      alertPath: 'rule',
      orderId: failure.orderId,
      requestId: uuidv4(),
      apiVersion: failure.apiVersion,
      responseKeys: failure.responseKeys,
      paymentMethod: failure.paymentMethod,
      devinUserId: failure.devinUserId,
      devinOrgId: failure.devinOrgId,
      devinEmail: failure.devinEmail,
      brand: failure.brand,
    });
  }
}

function randomBasket() {
  const target = Math.max(120, Math.min(900, 450 + (crypto.randomInt(300) - 150) * 2));
  const pool = [...CATALOG];
  const lines = [];
  let total = 0;
  while (total < target && pool.length && lines.length < 4) {
    const idx = crypto.randomInt(pool.length);
    const product = pool.splice(idx, 1)[0];
    lines.push({ sku: product.sku, qty: 1 });
    total += product.price;
  }
  return lines;
}

function syntheticCheckout(customer, retryPct) {
  return checkout({
    customerId: customer.customerId,
    cartId: customer.cartId,
    addressId: 'addr_syn',
    lines: randomBasket(),
    paymentMethod: 'card',
    cardToken: customer.cardToken,
  }, { synthetic: true }).catch(() => {
    if (crypto.randomInt(100) < retryPct * 100) {
      const delay = 5000 + crypto.randomInt(10000);
      const timer = setTimeout(() => {
        checkout({
          customerId: customer.customerId,
          cartId: customer.cartId,
          addressId: 'addr_syn',
          lines: randomBasket(),
          paymentMethod: 'card',
          cardToken: customer.cardToken,
        }, { synthetic: true }).catch(() => {});
      }, delay);
      timer.unref();
    }
  });
}

function startTraffic({ rate = 9, retryPct = 0.7, flipAfterSeconds = 120 } = {}) {
  if (traffic.running) stopTraffic();
  traffic.running = true;
  // Traffic starts on the healthy baseline; the armed flip ships 2026-10.
  psp.setVersion('2025-06');
  psp.armFlip(flipAfterSeconds, '2026-10');
  traffic.interval = setInterval(() => {
    const customer = SYNTHETIC_CUSTOMERS[crypto.randomInt(SYNTHETIC_CUSTOMERS.length)];
    syntheticCheckout(customer, retryPct);
  }, Math.round(60000 / rate));
  traffic.interval.unref();
  traffic.evalInterval = setInterval(() => evaluateAlertRule(), 5000);
  traffic.evalInterval.unref();
  traffic.stopTimer = setTimeout(() => stopTraffic(), TRAFFIC_MAX_MS);
  traffic.stopTimer.unref();
  return getMetrics();
}

function stopTraffic() {
  if (traffic.interval) clearInterval(traffic.interval);
  if (traffic.evalInterval) clearInterval(traffic.evalInterval);
  if (traffic.stopTimer) clearTimeout(traffic.stopTimer);
  traffic.interval = null;
  traffic.evalInterval = null;
  traffic.stopTimer = null;
  traffic.running = false;
  return getMetrics();
}

function walletAuthorize() {
  return `PAYID-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function checkout(data, { synthetic = false } = {}) {
  const requestId = uuidv4();
  const paymentMethod = data.paymentMethod === 'paypal' ? 'paypal' : 'card';
  const brand = synthetic ? BRANDS.rl : brandOf(data.brand);
  const customer = resolveCustomer(data, synthetic, brand);
  const lines = priceLines(data.lines, brand);
  const total = Math.round(lines.reduce((s, l) => s + l.lineTotal, 0) * 100) / 100;

  const order = orderStore.createPending({
    customerId: customer.id,
    cartId: customer.cartId,
    lines,
    total,
    shipTo: customer.shipTo,
    addressId: data.addressId,
    paymentMethod,
  });

  try {
    let paymentId;
    if (paymentMethod === 'paypal') {
      paymentId = walletAuthorize();
    } else {
      const pspResponse = await meridian.authorize({
        amount: total,
        currency: brand.currency,
        descriptor: brand.descriptor,
        cardToken: data.cardToken,
        reference: order.id,
      });
      paymentId = pspResponse.paymentId;
      if (!paymentId) {
        const missing = new Error('Missing payment id in PSP response');
        missing.pspStatus = pspResponse.status;
        missing.apiVersion = pspResponse.apiVersion;
        missing.responseKeys = pspResponse.responseKeys;
        throw missing;
      }
    }

    orderStore.complete(order.id, paymentId);
    recordAttempt(true, customer.id, total);
    incrementMetric('rl_checkout.success', { route: ROUTE, service: SERVICE });
    logger.info('Checkout completed', {
      requestId, orderId: order.id, total, paymentMethod, synthetic, service: SERVICE,
    });

    return {
      orderId: order.id,
      status: 'confirmed',
      order: {
        id: order.id,
        status: 'confirmed',
        total,
        currency: brand.currency,
        paymentMethod,
        lines,
        shipTo: customer.shipTo,
        estimatedDelivery: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        createdAt: order.createdAt,
      },
    };
  } catch (error) {
    recordAttempt(false, customer.id, total);
    incrementMetric('rl_checkout.failure', { route: ROUTE, service: SERVICE, errorClass: error.name });
    logger.error(error.message, {
      service: SERVICE,
      customer: CUSTOMER,
      orderId: order.id,
      requestId,
      pspStatus: error.pspStatus,
      apiVersion: error.apiVersion,
      responseKeys: (error.responseKeys || []).join(','),
      synthetic,
      brand: brand.key,
    });

    metrics.lastFailure = {
      message: error.message,
      orderId: order.id,
      requestId,
      apiVersion: error.apiVersion,
      responseKeys: error.responseKeys,
      paymentMethod,
      devinUserId: data.devinUserId,
      devinOrgId: data.devinOrgId,
      devinEmail: data.devinEmail,
      brand: brand.key,
    };

    if (!synthetic && !traffic.running && !alertSuppressed()) {
      fireAlert(error, {
        alertPath: 'instant',
        orderId: order.id,
        requestId,
        apiVersion: error.apiVersion,
        responseKeys: error.responseKeys,
        paymentMethod,
        devinUserId: data.devinUserId,
        devinOrgId: data.devinOrgId,
        devinEmail: data.devinEmail,
        brand: brand.key,
      });
    }

    error.statusCode = 502;
    error.code = 'PAYMENT_FAILED';
    error.requestId = requestId;
    throw error;
  }
}

function getOrder(id) {
  return orderStore.get(id);
}

function completeOrder(id, paymentId) {
  const order = orderStore.get(id);
  if (!order) return { error: 'not_found' };
  if (order.status !== 'pending') return { error: 'not_pending', order };
  orderStore.complete(id, paymentId);
  return { order: orderStore.get(id) };
}

function reset() {
  stopTraffic();
  psp.reset();
  orderStore.reset();
  metrics.attempts = [];
  metrics.incidentStartedAt = null;
  metrics.revenueAtRiskByCustomer = new Map();
  metrics.affectedCustomers = new Set();
  metrics.chatDrained = 0;
  metrics.lastAlertAt = null;
  metrics.alertFiredAt = null;
  metrics.ruleBreachSince = null;
  metrics.lastFailure = null;
  metrics.history = [];
  return getMetrics();
}

// Rolling 15-minute success-rate history, sampled every 10 s; the chat queue
// drains while the service is healthy. Unref'd and skipped under jest so the
// timers never keep a process alive.
if (process.env.NODE_ENV !== 'test') {
  setInterval(() => {
    const m = getMetrics();
    metrics.history.push({
      t: new Date().toISOString(),
      orderSuccessRate: m.orderSuccessRate,
      ordersPerMinute: m.ordersPerMinute,
    });
    if (metrics.history.length > 90) metrics.history.shift();
  }, 10 * 1000).unref();
  setInterval(() => {
    const m = getMetrics();
    if (m.orderSuccessRate > 0.95 && metrics.chatDrained < Math.floor(m.customersAffected / 3)) {
      metrics.chatDrained += 1;
    }
  }, 20 * 1000).unref();
}

module.exports = {
  CATALOG,
  ACCOUNT,
  DEFAULT_BASKET,
  GIFT_BOX_FEE,
  CARREFOUR_CATALOG,
  CARREFOUR_ACCOUNT,
  SYNTHETIC_CUSTOMERS,
  getAccount,
  getCatalog,
  checkout,
  getMetrics,
  getOrder,
  completeOrder,
  startTraffic,
  stopTraffic,
  reset,
  _internals: { metrics, traffic, evaluateAlertRule, recordAttempt },
};
