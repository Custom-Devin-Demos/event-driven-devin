const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const meridian = require('./ad6a0c70-meridian');
const psp = require('./ad6a0c70-meridian-psp');
const orderStore = require('./ad6a0c70-orders');

/**
 * La Poste — Boutique checkout-service (standalone demo, /laposte).
 *
 * Card payments go through the fictional PSP Meridian Pay. Its API 2026-10
 * renamed `paymentId` to `pspReference`; the adapter in ad6a0c70-meridian.js
 * still reads `paymentId`, so a card checkout authorizes the card and then
 * fails with "Missing payment id in PSP response". The defect is intentional.
 */

const SERVICE = 'laposte-checkout-service';
const ROUTE = '/api/ad6a0c70/checkout';
const VERTICAL = 'ad6a0c70';
// Alerts reuse the Slack/Devin credentials already configured for the shared
// storefront (the `_F63013C0` env vars, else the global ones), so this demo
// needs no new host env vars.
const ALERT_CREDENTIALS_CUSTOMER = 'f63013c0';
const VERTICAL_LABEL = 'La Poste — Boutique Checkout';
const SITE = 'laposte.fr';
const CURRENCY = 'EUR';
const DESCRIPTOR = 'LA POSTE';
const GIFT_WRAP_FEE = 1;
const ALERT_SUPPRESSION_MS = 10 * 60 * 1000;

const CATALOG = [
  { sku: 'LP-TB-1126485', name: 'Carnet de 12 timbres - 80 ans du Petit Prince - Lettre verte', price: 18.24, category: 'Timbres', giftBoxEligible: true },
  { sku: 'LP-TB-1126487', name: 'Carnet de 12 timbres - Splendeur florale - Lettre verte', price: 18.24, category: 'Timbres', giftBoxEligible: true },
  { sku: 'LP-TB-1126486', name: 'Carnet de 12 timbres - Biscuits français - Lettre verte', price: 18.24, category: 'Timbres', giftBoxEligible: true },
  { sku: 'LP-CO-2126908', name: 'Collector 4 timbres - Le Petit Prince - Lettre Verte', price: 7.5, category: 'Collection', giftBoxEligible: true },
  { sku: 'LP-TB-1126020', name: 'Timbre - Jean-Paul Belmondo (1933-2021) - Lettre Verte', price: 1.52, category: 'Timbres', giftBoxEligible: false },
  { sku: 'LP-TB-F1126013', name: 'Feuille de 15 timbres - 80 ans du Petit Prince - Lettre Internationale', price: 33.75, category: 'Timbres', giftBoxEligible: true },
  { sku: 'LP-BL-500520345', name: 'Boîte aux lettres normalisée Balthazar en acier galvanisé - 1 porte - Noir', price: 50.71, category: 'Boîtes aux lettres', giftBoxEligible: false },
  { sku: 'LP-RE-600518206', name: 'Boîte de 100 Liasses Recommandées Manuelles avec Accusé de Réception', price: 52.56, category: 'Lettres recommandées', giftBoxEligible: false },
];

const ACCOUNT = {
  id: 'cus_julien_fr',
  name: 'Julien Moreau',
  email: 'julien.moreau@example.fr',
  address: {
    id: 'addr_julien_lyon',
    line1: '24 rue de la République',
    line2: '',
    city: 'Lyon',
    zip: '69002',
    country: 'France',
  },
  card: {
    token: 'tok_julien_fr_visa_4242',
    brand: 'Visa',
    last4: '4242',
    exp: '08/29',
  },
  cartId: 'pan_julien_fr',
};

const DEFAULT_BASKET = {
  cartId: 'pan_julien_fr',
  lines: [
    { sku: 'LP-TB-1126485', qty: 1 },
    { sku: 'LP-CO-2126908', qty: 1, giftBox: true },
  ],
};

const metrics = {
  attempts: [], // { t, success, customerId, total }
  lastAlertAt: null,
  alertFiredAt: null,
};

function validationError(message, code) {
  const err = new Error(message);
  err.name = 'ValidationError';
  err.code = code || 'VALIDATION_ERROR';
  err.statusCode = 400;
  return err;
}

function formatShipTo(addr) {
  return `${addr.line1}${addr.line2 ? `, ${addr.line2}` : ''}, ${addr.zip} ${addr.city}, ${addr.country}`;
}

function getCatalog() {
  return {
    products: CATALOG,
    customer: ACCOUNT,
    basket: DEFAULT_BASKET,
    giftBoxFee: GIFT_WRAP_FEE,
    currency: CURRENCY,
    pspApiVersion: psp.getVersion(),
  };
}

function resolveCustomer(data) {
  const customerId = data.customerId || ACCOUNT.id;
  if (customerId !== ACCOUNT.id) {
    throw validationError('Client inconnu.', 'UNKNOWN_CUSTOMER');
  }
  if (data.paymentMethod === 'card' && data.cardToken !== ACCOUNT.card.token) {
    throw validationError('Carte enregistrée introuvable.', 'UNKNOWN_CARD');
  }
  return {
    id: ACCOUNT.id,
    cartId: data.cartId || ACCOUNT.cartId,
    shipTo: formatShipTo(ACCOUNT.address),
  };
}

function priceLines(lines) {
  if (!Array.isArray(lines) || !lines.length) {
    throw validationError('Votre panier est vide.', 'EMPTY_BAG');
  }
  return lines.map((line) => {
    const product = CATALOG.find((p) => p.sku === String(line.sku));
    if (!product) {
      throw validationError(`Le produit ${line.sku} n’est plus disponible.`, 'ITEM_UNAVAILABLE');
    }
    const qty = Number(line.qty);
    if (!Number.isInteger(qty) || qty < 1 || qty > 5) {
      throw validationError(`La quantité de ${product.name} doit être comprise entre 1 et 5.`, 'INVALID_QUANTITY');
    }
    const giftBox = line.giftBox === true;
    if (giftBox && !product.giftBoxEligible) {
      throw validationError(`L’emballage cadeau n’est pas disponible pour ${product.name}.`, 'GIFT_WRAP_UNAVAILABLE');
    }
    const lineTotal = Math.round((product.price * qty + (giftBox ? GIFT_WRAP_FEE : 0)) * 100) / 100;
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
  if (metrics.attempts.length > 500) metrics.attempts.shift();
}

function getMetrics() {
  const cutoff = Date.now() - 60 * 1000;
  const attempts = metrics.attempts.filter((a) => a.t >= cutoff);
  const successes = attempts.filter((a) => a.success).length;
  const orderSuccessRate = attempts.length ? Math.round((successes / attempts.length) * 10000) / 10000 : 1;
  const open = psp.listAuthorizations().filter((a) => !a.voidedAt);
  const chargedWithoutOrder = open.filter((a) => {
    const order = orderStore.get(a.reference);
    return order && order.status === 'pending';
  }).length;
  const byReference = new Map();
  open.forEach((a) => byReference.set(a.reference, (byReference.get(a.reference) || 0) + 1));
  const duplicateAuthorizations = [...byReference.values()]
    .reduce((sum, count) => sum + Math.max(0, count - 1), 0);
  return {
    window: '60s',
    attempts: attempts.length,
    orderSuccessRate,
    ordersPerMinute: successes,
    chargedWithoutOrder,
    duplicateAuthorizations,
    pspApiVersion: psp.getVersion(),
    alertFiredAt: metrics.alertFiredAt,
  };
}

function alertSuppressed() {
  return metrics.lastAlertAt && Date.now() - metrics.lastAlertAt < ALERT_SUPPRESSION_MS;
}

function buildPromptContext(error) {
  const m = getMetrics();
  const pct = Math.round(m.orderSuccessRate * 100);
  return `Success rate ${pct}% over last 60s (${m.attempts} attempts). Top error: ${error.message}. `
    + `Customers on ${SITE} are being charged without an order being created — every "Réessayer" retry adds another pending card authorization.`;
}

const PROMPT_APPENDIX = 'Follow docs/ad6a0c70/RUNBOOK.md. The fix must satisfy docs/ad6a0c70/ENGINEERING_STANDARDS.md (schema validation + contract test from the vendor\'s published example in docs/ad6a0c70/vendors/meridian-pay/CHANGELOG.md, Idempotency-Key derived from the order reference, regression test). Keep the customer-facing PAYMENT_FAILED message unchanged; internally distinguish PSP_SCHEMA_MISMATCH. In the PR description include root cause, blast radius from GET /api/ad6a0c70/metrics, and a rollout note.';

function fireAlert(error, ctx) {
  metrics.lastAlertAt = Date.now();
  metrics.alertFiredAt = new Date().toISOString();

  Sentry.captureException(error, {
    tags: {
      route: ROUTE, service: SERVICE, vertical: VERTICAL, brand: 'laposte', alert_path: 'instant',
    },
    extra: { orderId: ctx.orderId, requestId: ctx.requestId, apiVersion: ctx.apiVersion },
  });

  createSessionAndAlert({
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/ad6a0c70.js — checkout',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: ctx.devinUserId,
    devinEmail: ctx.devinEmail,
    devinOrgId: ctx.devinOrgId,
    customer: ALERT_CREDENTIALS_CUSTOMER,
    service: SERVICE,
    verticalLabel: VERTICAL_LABEL,
    tags: [
      { key: 'route', value: ROUTE },
      { key: 'service', value: SERVICE },
      { key: 'brand', value: 'La Poste' },
      { key: 'psp_api_version', value: ctx.apiVersion || 'unknown' },
      { key: 'payment_method', value: ctx.paymentMethod || 'card' },
    ],
    extra: {
      orderId: ctx.orderId,
      requestId: ctx.requestId,
      apiVersion: ctx.apiVersion,
      responseKeys: (ctx.responseKeys || []).join(','),
      promptContext: buildPromptContext(error),
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
    triggeredRule: '',
  }).catch((err) => {
    logger.error('Failed to trigger Devin session', { error: err.message, requestId: ctx.requestId });
  });
}

function walletAuthorize() {
  return `PAYID-${Date.now().toString(36).toUpperCase()}${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
}

async function checkout(data) {
  const requestId = uuidv4();
  const paymentMethod = data.paymentMethod === 'paypal' ? 'paypal' : 'card';
  const customer = resolveCustomer({ ...data, paymentMethod });
  const lines = priceLines(data.lines);
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
        currency: CURRENCY,
        descriptor: DESCRIPTOR,
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
    incrementMetric('laposte_checkout.success', { route: ROUTE, service: SERVICE });
    logger.info('La Poste checkout completed', {
      requestId, orderId: order.id, total, currency: CURRENCY, paymentMethod, service: SERVICE, brand: 'La Poste',
    });

    return {
      orderId: order.id,
      status: 'confirmed',
      order: {
        id: order.id,
        status: 'confirmed',
        total,
        currency: CURRENCY,
        paymentMethod,
        lines,
        shipTo: customer.shipTo,
        estimatedDelivery: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString().slice(0, 10),
        createdAt: order.createdAt,
      },
    };
  } catch (error) {
    recordAttempt(false, customer.id, total);
    incrementMetric('laposte_checkout.failure', { route: ROUTE, service: SERVICE, errorClass: error.name });
    logger.error(error.message, {
      service: SERVICE,
      vertical: VERTICAL,
      brand: 'La Poste',
      site: SITE,
      orderId: order.id,
      requestId,
      pspStatus: error.pspStatus,
      apiVersion: error.apiVersion,
      responseKeys: (error.responseKeys || []).join(','),
    });

    if (!data.alertsOff && !alertSuppressed()) {
      fireAlert(error, {
        orderId: order.id,
        requestId,
        apiVersion: error.apiVersion,
        responseKeys: error.responseKeys,
        paymentMethod,
        devinUserId: data.devinUserId,
        devinOrgId: data.devinOrgId,
        devinEmail: data.devinEmail,
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
  psp.reset();
  orderStore.reset();
  metrics.attempts = [];
  metrics.lastAlertAt = null;
  metrics.alertFiredAt = null;
  return getMetrics();
}

module.exports = {
  CATALOG,
  ACCOUNT,
  DEFAULT_BASKET,
  GIFT_WRAP_FEE,
  VERTICAL_LABEL,
  ALERT_CREDENTIALS_CUSTOMER,
  getCatalog,
  checkout,
  getMetrics,
  getOrder,
  completeOrder,
  reset,
};
