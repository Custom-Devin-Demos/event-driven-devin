const axios = require('axios');
const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { postOncallAlert } = require('../oncall');
const { declareDatadogIncident } = require('../datadog-incidents');

/**
 * Disney Parks Tickets & Resorts (90ccfbb2) — storefront facade over the
 * Java resort-inventory service (resort-inventory/, Spring Boot on Java 8).
 *
 * The storefront never crashes. When a guest's calendar shows a date as
 * SOLD OUT, this module asks the inventory service's audit endpoint whether
 * that is real; product-dates that read sold out while confirmed sales are
 * still below capacity are a revenue leak, and the
 * `resort_inventory.soldout_with_capacity` monitor fires: a monitor card in
 * the On-Call alerts channel plus a SEV-2 Datadog incident. No Devin session
 * is created here — the Devin Oncall responder on the alerts channel picks
 * the card up, like the Gusto payroll monitor.
 */

const SLUG = '90ccfbb2';
const SERVICE = 'resort-inventory';
const INVENTORY_URL = () => (process.env.RESORT_INVENTORY_URL || 'http://resort-inventory:8080').replace(/\/$/, '');
const HOLD_ALERT_COOLDOWN_MS = () => Number(process.env.RESORT_INVENTORY_ALERT_COOLDOWN_MS) || 10 * 60 * 1000;
const lastHoldAlertAt = new Map();
const MONITOR_COOLDOWN_MS = () => Number(process.env.RESORT_INVENTORY_MONITOR_COOLDOWN_MS) || 10 * 60 * 1000;
const PRODUCT_RE = /^(wdw|dlr)-[a-z]{2,4}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}$/;

let lastMonitorFiredAt = 0;
let monitorInFlight = null;

function inventoryError(status, code, message) {
  const error = new Error(message);
  error.statusCode = status;
  error.code = code;
  return error;
}

async function callInventory(method, path, { params, data } = {}) {
  try {
    const response = await axios({
      method,
      url: `${INVENTORY_URL()}${path}`,
      params,
      data,
      timeout: 8000,
      validateStatus: () => true,
    });
    if (response.status >= 400) {
      const body = response.data || {};
      throw inventoryError(response.status, body.code || 'INVENTORY_ERROR', body.error || `Inventory returned ${response.status}`);
    }
    return response.data;
  } catch (error) {
    if (error.statusCode) throw error;
    logger.error('Resort inventory service unreachable', { path, error: error.message, service: SERVICE });
    throw inventoryError(503, 'INVENTORY_UNAVAILABLE', 'We are unable to check availability right now.');
  }
}

function validateProduct(productId) {
  if (!PRODUCT_RE.test(productId || '')) throw inventoryError(400, 'INVALID_PRODUCT', 'Unknown product');
}

function validateDate(date) {
  if (!DATE_RE.test(date || '')) throw inventoryError(400, 'INVALID_DATE', 'Dates must be YYYY-MM-DD');
}

async function getAvailability({ productId, from, days }) {
  validateProduct(productId);
  validateDate(from);
  const result = await callInventory('get', '/api/availability', {
    params: { productId, from, days: Math.min(Math.max(Number(days) || 42, 1), 62) },
  });
  const soldOut = (result.days || []).filter((d) => d.status === 'SOLD_OUT').map((d) => d.date);
  if (soldOut.length) {
    incrementMetric('resort_inventory.calendar_soldout_impressions', { productId, service: SERVICE });
    logger.info('Calendar served with sold-out dates', { productId, soldOut, service: SERVICE });
  }
  return result;
}

async function createHold({ productId, date, quantity, devinEmail }) {
  validateProduct(productId);
  validateDate(date);
  const qty = Number(quantity) || 1;
  try {
    return await callInventory('post', '/api/holds', { data: { productId, date, quantity: qty } });
  } catch (error) {
    if (!error.statusCode || error.statusCode < 500 || error.code === 'INVENTORY_UNAVAILABLE') throw error;
    const reference = `INV-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    incrementMetric('resort_inventory.hold_failure', { productId, code: error.code, service: SERVICE });
    logger.error('Add to cart failed: hold could not be posted', {
      reference, productId, date, quantity: qty, code: error.code, error: error.message, service: SERVICE,
    });
    Sentry.captureException(error, {
      tags: { route: '/api/90ccfbb2/holds', service: SERVICE, productId, alert_path: 'instant' },
      extra: { reference, date, quantity: qty, code: error.code },
    });
    const failure = inventoryError(500, 'HOLD_FAILED', 'We are unable to add these tickets to your cart right now.');
    failure.reference = reference;
    failure.detail = error.message;
    const signature = `${productId}|${error.code}`;
    if (Date.now() - (lastHoldAlertAt.get(signature) || 0) < HOLD_ALERT_COOLDOWN_MS()) throw failure;
    lastHoldAlertAt.set(signature, Date.now());
    const email = EMAIL_RE.test(devinEmail || '') ? devinEmail : undefined;
    declareDatadogIncident({
      title: 'Disney Parks: Add to Cart failing on holds',
      summary: `POST /api/holds returns 500 (${error.code}: ${error.message}) for ${productId} on ${date}.`,
      runRef: reference,
      service: SERVICE,
      triggeredBy: email || 'parks-inventory-oncall',
      repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
      severity: 'SEV-2',
    }).catch((ddError) => logger.warn('Failed to declare Datadog incident for resort inventory', { error: ddError.message, reference }));
    postOncallAlert(SLUG, { runRef: reference, devinEmail: email })
      .then((alert) => logger.info('Posting alert and triggering Devin', { reference, ok: alert && alert.ok, service: SERVICE }))
      .catch((alertError) => logger.warn('Resort inventory on-call alert failed', { error: alertError.message, reference }));
    throw failure;
  }
}

async function checkout({ holdId }) {
  if (!/^H-[0-9A-F]{8}$/.test(holdId || '')) throw inventoryError(400, 'INVALID_HOLD', 'Unknown hold');
  return callInventory('post', '/api/checkout', { data: { holdId } });
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The monitor: dates that read SOLD OUT while confirmed sales are below
 * capacity. Fires at most once per cooldown window.
 */
async function evaluateCapacityMonitor({ devinEmail, trigger } = {}) {
  if (monitorInFlight) return monitorInFlight;
  monitorInFlight = (async () => {
    const audit = await callInventory('get', '/internal/inventory/audit', { params: { from: todayIso(), days: 60 } });
    const rows = audit.soldOutWithCapacity || [];
    const unsoldUnits = rows.reduce((sum, r) => sum + (r.unsoldCapacity || 0), 0);
    if (!rows.length) return { fired: false, rows: 0 };

    incrementMetric('resort_inventory.soldout_with_capacity', { service: SERVICE });
    logger.warn('Inventory monitor: dates sold out with unsold capacity', {
      service: SERVICE,
      productDates: rows.length,
      unsoldUnits,
      activeHolds: audit.activeHolds,
      holdsPastExpiry: audit.holdsPastExpiry,
      oldestActiveHoldCreatedAt: audit.oldestActiveHoldCreatedAt,
      sample: rows.slice(0, 5).map((r) => `${r.productId}@${r.date} sold=${r.sold}/${r.capacity} held=${r.held}`),
      trigger,
    });

    if (Date.now() - lastMonitorFiredAt < MONITOR_COOLDOWN_MS()) return { fired: false, rows: rows.length, cooldown: true };
    lastMonitorFiredAt = Date.now();

    const runRef = `INV-${crypto.randomBytes(3).toString('hex').toUpperCase()}`;
    const email = EMAIL_RE.test(devinEmail || '') ? devinEmail : undefined;
    declareDatadogIncident({
      title: 'Disney Parks: peak dates sold out with unsold capacity',
      summary: `${rows.length} park/resort product-dates show SOLD OUT to guests while ${unsoldUnits} units remain unsold; active cart holds are not being released.`,
      runRef,
      service: SERVICE,
      triggeredBy: email || 'parks-inventory-oncall',
      repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
      severity: 'SEV-2',
    }).catch((error) => logger.warn('Failed to declare Datadog incident for resort inventory', { error: error.message, runRef }));

    const alert = await postOncallAlert(SLUG, { runRef, devinEmail: email });
    logger.info('Posting alert and triggering Devin', { runRef, ok: alert && alert.ok, channel: alert && alert.channel, service: SERVICE });
    return { fired: true, rows: rows.length, runRef, alert };
  })();
  try {
    return await monitorInFlight;
  } finally {
    monitorInFlight = null;
  }
}

function resetMonitorForTests() {
  lastMonitorFiredAt = 0;
  monitorInFlight = null;
}

module.exports = {
  getAvailability,
  createHold,
  checkout,
  evaluateCapacityMonitor,
  resetMonitorForTests,
};
