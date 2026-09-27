/**
 * 8c0320af — order placement.
 *
 * Every order re-derives the amount due at delivery from the vehicle record
 * and the payment program before it is accepted. A quote that does not
 * reconcile is rejected so the contract figure never drifts from the number
 * the customer saw on the review screen.
 */
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  SERVICE, STUDIO, FEES, TAX_RATES, findTrim, findVehicle, findProgram, getQuote, clearQuotes,
} = require('./8c0320af');

const ROUTE = '/api/8c0320af/orders';
const RECONCILE_TOLERANCE = 0.01;

const ORDERS = [];
const MISMATCHES = [];

class QuoteMismatchError extends Error {
  constructor(message, details) {
    super(message);
    this.name = 'QuoteMismatchError';
    this.status = 409;
    this.code = 'QUOTE_MISMATCH';
    this.details = details;
  }
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function money(n) {
  return n.toFixed(2);
}

function currentStatus() {
  return {
    status: MISMATCHES.length ? 'degraded' : 'ready',
    orders: ORDERS.length,
    mismatches: MISMATCHES.length,
    lastMismatchAt: MISMATCHES.length ? MISMATCHES[MISMATCHES.length - 1].at : null,
  };
}

/**
 * Independent re-derivation of the amount due at delivery from source data.
 * Mirrors the contract math used by the retail installment / lease agreement.
 */
function recomputeDueAtDelivery(quote) {
  const vehicle = findVehicle(quote.vehicle.vin);
  const trim = findTrim(vehicle.trim);
  const program = findProgram(quote.program.code);
  const rate = TAX_RATES[quote.state];

  const optionsTotal = vehicle.options.reduce((sum, o) => sum + o.price, 0);
  const sellingPrice = trim.basePrice + optionsTotal - (vehicle.inventoryDiscount || 0);
  const tax = round2(sellingPrice * rate);

  if (program.type === 'lease') {
    return round2(
      program.capCostReduction
        + program.monthlyPayment[trim.code]
        + FEES.acquisition
        + FEES.documentation
        + tax,
    );
  }
  if (program.type === 'finance') {
    const downPayment = round2(sellingPrice * program.downPaymentPct);
    return round2(downPayment + FEES.documentation + tax);
  }
  return round2(sellingPrice + FEES.destination + FEES.documentation + tax);
}

/**
 * Attribute a reconciliation delta to a known drift pattern so the alert
 * carries a hypothesis instead of a bare number.
 */
function classifyDelta(delta, quote) {
  const near = (n) => Math.abs(Math.abs(delta) - Math.abs(n)) < RECONCILE_TOLERANCE;
  const { pricing, tax, terms } = quote;
  if (pricing.inventoryDiscount && near(pricing.inventoryDiscount * tax.rate)) {
    return 'discount_applied_twice_in_tax_base';
  }
  if (near(FEES.acquisition)) return 'acquisition_fee_omitted';
  if (near(FEES.documentation)) return 'documentation_fee_omitted';
  if (terms && terms.monthlyPayment && near(terms.monthlyPayment)) return 'first_payment_omitted';
  if (near(pricing.destination * tax.rate)) return 'destination_excluded_from_tax_base';
  return 'unclassified';
}

function reconcileQuote(orderId, quote) {
  const recomputed = recomputeDueAtDelivery(quote);
  const quoted = quote.amountDueAtDelivery;
  const delta = round2(recomputed - quoted);

  if (Math.abs(delta) < RECONCILE_TOLERANCE) {
    return { quoted, recomputed, delta: 0 };
  }

  const reason = classifyDelta(delta, quote);
  const details = {
    orderId,
    quoteId: quote.quoteId,
    field: 'amountDueAtDelivery',
    quoted: money(quoted),
    recomputed: money(recomputed),
    delta: money(delta),
    reason,
  };

  logger.warn(
    `quote_mismatch orderId=${orderId} quoteId=${quote.quoteId} field=amountDueAtDelivery `
      + `quoted=${details.quoted} recomputed=${details.recomputed} delta=${details.delta} reason=${reason}`,
    { ...details, vin: quote.vehicle.vin, program: quote.program.code, state: quote.state, service: SERVICE },
  );
  incrementMetric('ev_checkout.quote_mismatch', { route: ROUTE, reason, program: quote.program.code });

  throw new QuoteMismatchError(
    `Quote ${quote.quoteId} does not reconcile: amountDueAtDelivery quoted ${details.quoted}, recomputed ${details.recomputed} (delta ${details.delta})`,
    details,
  );
}

function formatOrder({ orderId, quote, reconciliation }) {
  return {
    success: true,
    orderId,
    orderNumber: `RN-${orderId.slice(0, 8).toUpperCase()}`,
    quoteId: quote.quoteId,
    placedAt: new Date().toISOString(),
    studio: STUDIO,
    vehicle: quote.vehicle,
    program: quote.program,
    amountDueAtDelivery: reconciliation.recomputed,
    deliveryWindow: STUDIO.deliveryWindow,
    status: 'reservation_confirmed',
  };
}

/**
 * Place an order against a previously issued quote.
 */
async function placeOrder(data) {
  const requestId = uuidv4();
  const orderId = `ord_${uuidv4()}`;
  const startTime = Date.now();

  const quote = getQuote(data.quoteId);
  if (!quote) {
    const err = new Error(`Quote ${data.quoteId} not found or expired`);
    err.status = 404;
    err.code = 'QUOTE_NOT_FOUND';
    throw err;
  }

  logger.info('Placing order', {
    requestId,
    orderId,
    quoteId: quote.quoteId,
    vin: quote.vehicle.vin,
    program: quote.program.code,
    amountDueAtDelivery: quote.amountDueAtDelivery,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const reconciliation = reconcileQuote(orderId, quote);
    const order = formatOrder({ orderId, quote, reconciliation });
    ORDERS.push(order);

    const duration = Date.now() - startTime;
    incrementMetric('ev_checkout.order.success', { route: ROUTE, program: quote.program.code });
    recordTiming('ev_checkout.order.latency', duration, { route: ROUTE });
    logger.info('Order placed', {
      requestId, orderId, orderNumber: order.orderNumber, amountDueAtDelivery: order.amountDueAtDelivery, durationMs: duration, service: SERVICE,
    });

    return order;
  } catch (error) {
    const duration = Date.now() - startTime;
    const details = error.details || {};

    MISMATCHES.push({ orderId, quoteId: quote.quoteId, at: new Date().toISOString(), ...details });

    incrementMetric('ev_checkout.order.failure', {
      route: ROUTE, errorClass: error.name, code: error.code || 'ORDER_FAILED', program: quote.program.code,
    });
    recordTiming('ev_checkout.order.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Order rejected', {
      requestId,
      orderId,
      quoteId: quote.quoteId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        program: quote.program.code,
        trim: quote.vehicle.trim,
        reason: details.reason || 'n/a',
        alert_path: 'instant',
      },
      extra: {
        requestId,
        orderId,
        quoteId: quote.quoteId,
        vin: quote.vehicle.vin,
        state: quote.state,
        ...details,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/8c0320af-orders.js \u2014 reconcileQuote',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Air Studio Checkout \u2014 Orders',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'program', value: quote.program.code },
        { key: 'trim', value: quote.vehicle.trim },
        { key: 'reason', value: details.reason || 'n/a' },
      ],
      extra: {
        requestId,
        orderId,
        quoteId: quote.quoteId,
        vin: quote.vehicle.vin,
        stockNumber: quote.vehicle.stockNumber,
        state: quote.state,
        ...details,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '8c0320af@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, orderId });
    });

    throw error;
  }
}

function resetOrders() {
  const cleared = ORDERS.length + MISMATCHES.length + clearQuotes();
  ORDERS.length = 0;
  MISMATCHES.length = 0;
  logger.info('Demo state reset', { cleared, service: SERVICE });
  incrementMetric('ev_checkout.reset', { route: `${ROUTE}/reset` });
  return { success: true, cleared, status: currentStatus() };
}

module.exports = {
  placeOrder,
  resetOrders,
  currentStatus,
  recomputeDueAtDelivery,
  reconcileQuote,
  classifyDelta,
  QuoteMismatchError,
  ORDERS,
  MISMATCHES,
};
