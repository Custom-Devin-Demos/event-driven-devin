const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/vaccines/order';
const SERVICE = 'vaccine-ordering-api';

/**
 * Orderable vaccine packs, keyed by 10-digit NDC.
 */
const CATALOG = [
  { ndc: '5816084952', label: 'SHINGRIX (PFS)', dosesPerPack: 10, priceCents: 203000 },
  { ndc: '5816084811', label: 'AREXVY (Vial)', dosesPerPack: 10, priceCents: 280000 },
  { ndc: '5816084252', label: 'BOOSTRIX (PFS)', dosesPerPack: 10, priceCents: 47000 },
  { ndc: '5816082152', label: 'ENGERIX-B Adult (PFS)', dosesPerPack: 10, priceCents: 64000 },
  { ndc: '5816082111', label: 'ENGERIX-B Adult (Vial)', dosesPerPack: 10, priceCents: 61500 },
  { ndc: '5816082652', label: 'HAVRIX Adult (PFS)', dosesPerPack: 10, priceCents: 78000 },
  { ndc: '5816081552', label: 'TWINRIX (PFS)', dosesPerPack: 10, priceCents: 125000 },
];

/**
 * Cold-chain distribution centers that can hold allocation for a practice.
 * `packs` is the refrigerated allocation available at that center.
 */
const DISTRIBUTION_CENTERS = [
  { id: 'dc-pa-philadelphia', region: 'US-PA', packs: 0 },
  { id: 'dc-nc-zebulon', region: 'US-NC', packs: 0 },
  { id: 'dc-tn-memphis', region: 'US-TN', packs: 0 },
  { id: 'dc-tx-dallas', region: 'US-TX', packs: 0 },
  { id: 'dc-nv-reno', region: 'US-NV', packs: 0 },
  { id: 'dc-ga-atlanta', region: 'US-GA', packs: 0 },
  { id: 'dc-il-chicago', region: 'US-IL', packs: 0 },
  { id: 'dc-oh-columbus', region: 'US-OH', packs: 240 },
];

const ALLOCATION_DEADLINE_MS = 8000;
const DC_CALL_LATENCY_MS = [1000, 1250];
const NEXT_DAY_FEE_CENTS = 3500;
const TIER_FACTOR = { premium: 0.94, standard: 1, basic: 1.08 };

/**
 * Ask one distribution center to hold allocation. Each call is a round trip
 * to the cold-chain logistics partner.
 */
function holdAtCenter(center, packs) {
  const [minMs, maxMs] = DC_CALL_LATENCY_MS;
  return new Promise((resolve) => {
    setTimeout(() => {
      resolve({ center: center.id, held: center.packs >= packs, available: center.packs });
    }, minMs + Math.random() * (maxMs - minMs));
  });
}

function withDeadline(promise, ms, label) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} exceeded ${ms}ms`);
      err.code = 'ALLOCATION_TIMEOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

/**
 * Walk the distribution centers and hold the order's packs at the first one
 * that has the allocation.
 */
async function confirmAllocation(item, packs, orderId) {
  for (const center of DISTRIBUTION_CENTERS) {
    const startedAt = Date.now();
    const attempt = await holdAtCenter(center, packs);
    logger.info('Allocation hold probe', {
      orderId,
      ndc: item.ndc,
      center: center.id,
      region: center.region,
      held: attempt.held,
      durationMs: Date.now() - startedAt,
      service: SERVICE,
      endpoint: 'allocation/v2/hold',
    });
    if (attempt.held) {
      return { center: center.id, allocationRef: `ALC-${orderId.slice(0, 8).toUpperCase()}` };
    }
  }
  const err = new Error(`No distribution center holds allocation for NDC ${item.ndc}`);
  err.code = 'NO_ALLOCATION';
  throw err;
}

function lookupItem(ndc) {
  return CATALOG.find((item) => item.ndc === String(ndc || '').replace(/-/g, '')) || null;
}

/**
 * Submit a practice's vaccine order.
 */
async function submitOrder(orderData, options = {}) {
  const startTime = Date.now();
  const orderId = uuidv4();

  logger.info('Submitting vaccine order', {
    orderId,
    ndc: orderData.ndc,
    quantity: orderData.quantity,
    practiceAccount: orderData.practiceAccount,
    shipTo: orderData.shipTo,
    service: SERVICE,
    route: ROUTE,
  });

  try {
    const item = lookupItem(orderData.ndc);
    if (!item) {
      const err = new Error(`Unknown NDC: ${orderData.ndc}`);
      err.code = 'PRODUCT_NOT_FOUND';
      throw err;
    }

    const quantity = Math.min(Math.max(parseInt(orderData.quantity, 10) || 1, 1), 50);
    const allocation = await withDeadline(
      confirmAllocation(item, quantity, orderId),
      ALLOCATION_DEADLINE_MS,
      'Allocation hold',
    );

    const duration = Date.now() - startTime;
    const shippingCents = orderData.delivery === 'nextday' ? NEXT_DAY_FEE_CENTS : 0;
    const unitCents = Math.round(item.priceCents * (TIER_FACTOR[orderData.accountTier] || 1));
    const subtotalCents = unitCents * quantity;

    incrementMetric('vaccine_order.submit.success', { route: ROUTE, ndc: item.ndc });
    recordTiming('vaccine_order.submit.latency', duration, { route: ROUTE });

    return {
      success: true,
      orderId: `ORD-${orderId.slice(0, 8).toUpperCase()}`,
      ndc: item.ndc,
      quantity,
      unitPrice: unitCents / 100,
      doses: quantity * item.dosesPerPack,
      subtotal: subtotalCents / 100,
      total: (subtotalCents + shippingCents) / 100,
      allocationRef: allocation.allocationRef,
      submittedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('vaccine_order.submit.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('vaccine_order.submit.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Vaccine order submission failed', {
      orderId,
      error: error.message,
      errorClass: error.name,
      code: error.code,
      durationMs: duration,
      ndc: orderData.ndc,
      shipTo: orderData.shipTo,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        ...(options.synthetic ? { synthetic_probe: 'true' } : {}),
      },
      extra: { orderId, ndc: orderData.ndc, quantity: orderData.quantity, shipTo: orderData.shipTo },
    });

    throw error;
  }
}

module.exports = { submitOrder, CATALOG, DISTRIBUTION_CENTERS };
