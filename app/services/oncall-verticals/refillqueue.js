/* global AbortController */
const crypto = require('crypto');
const { setTimeout: delay } = require('node:timers/promises');
const logger = require('../../telemetry/logger');
const { tracer, incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const ROUTE = '/api/oncall/refillqueue/refresh';
const SERVICE = 'lumistry-refills-api';
const REFRESH_DEADLINE_MS = 8000;
const STATUS_LOOKUP_MS = 1100;

const REFILLS = [
  { id: 'RF-4101', patient: 'Avery Bennett', rxNumber: '86001401', channel: 'Web', method: 'Pickup', status: 'Good for refilling', submitted: '9:42 AM', initials: 'AB' },
  { id: 'RF-4102', patient: 'Morgan Ellis', rxNumber: '86001402', channel: 'IVR', method: 'Pickup', status: 'No more refills', submitted: '9:38 AM', initials: 'ME' },
  { id: 'RF-4103', patient: 'Jordan Hayes', rxNumber: '86001403', channel: 'App', method: 'Delivery', status: 'Rx not found', submitted: '9:31 AM', initials: 'JH' },
  { id: 'RF-4104', patient: 'Riley Brooks', rxNumber: '86001404', channel: 'Web', method: 'Pickup', status: 'Good for refilling', submitted: '9:24 AM', initials: 'RB' },
  { id: 'RF-4105', patient: 'Quinn Parker', rxNumber: '86001405', channel: 'App', method: 'Pickup', status: 'Good for refilling', submitted: '9:19 AM', initials: 'QP' },
  { id: 'RF-4106', patient: 'Casey Reed', rxNumber: '86001406', channel: 'IVR', method: 'Delivery', status: 'No more refills', submitted: '9:12 AM', initials: 'CR' },
  { id: 'RF-4107', patient: 'Taylor Lane', rxNumber: '86001407', channel: 'Web', method: 'Pickup', status: 'Good for refilling', submitted: '9:05 AM', initials: 'TL' },
  { id: 'RF-4108', patient: 'Drew Collins', rxNumber: '86001408', channel: 'App', method: 'Pickup', status: 'Good for refilling', submitted: '8:57 AM', initials: 'DC' },
];

function selectRefills(data) {
  const ids = data && data.refillIds;
  if (!data || typeof data !== 'object' || Array.isArray(data)
    || !Array.isArray(ids) || !ids.length || ids.length > REFILLS.length
    || new Set(ids).size !== ids.length || ids.some((id) => !REFILLS.some((row) => row.id === id))) {
    const error = new Error('Select between one and eight distinct pending refills.');
    error.code = 'INVALID_REFILLS';
    throw error;
  }
  return ids.map((id) => REFILLS.find((row) => row.id === id));
}

async function fetchPrescriptionStatus(refill, refreshId, signal) {
  const startedAt = Date.now();
  return tracer.trace('pharmacy.prescription.status', {
    service: SERVICE,
    resource: 'GET /prescriptions/:id/status',
    tags: { 'peer.service': 'pharmacy-management', 'refill.id': refill.id },
  }, async () => {
    try {
      await delay(STATUS_LOOKUP_MS, undefined, { signal });
      logger.info('Pharmacy status lookup completed', {
        refreshId, refillId: refill.id, durationMs: Date.now() - startedAt,
        service: SERVICE, route: ROUTE, upstream: 'pharmacy-management',
      });
      return { ...refill };
    } catch (error) {
      logger.warn('Pharmacy status lookup interrupted', {
        refreshId, refillId: refill.id, durationMs: Date.now() - startedAt,
        service: SERVICE, route: ROUTE, code: error.code,
      });
      throw error;
    }
  });
}

async function loadRefillStatuses(refills, refreshId, signal) {
  const rows = [];
  for (const refill of refills) {
    rows.push(await fetchPrescriptionStatus(refill, refreshId, signal));
  }
  return rows;
}

async function refreshRefillQueue(data) {
  const refills = selectRefills(data);
  const startedAt = Date.now();
  const refreshId = `RFR-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), REFRESH_DEADLINE_MS);
  const tags = { route: ROUTE, service: SERVICE, scope: refills.length === 1 ? 'single' : 'batch' };
  logger.info('Refill status refresh started', { refreshId, count: refills.length, ...tags });

  try {
    const rows = await loadRefillStatuses(refills, refreshId, controller.signal);
    incrementMetric('refillqueue.refresh.success', tags);
    return { success: true, refreshId, refills: rows, durationMs: Date.now() - startedAt };
  } catch (cause) {
    const error = controller.signal.aborted ? new Error('Refill status refresh deadline exceeded') : cause;
    if (controller.signal.aborted) error.code = 'REFILL_REFRESH_TIMEOUT';
    error.refreshId = refreshId;
    incrementMetric('refillqueue.refresh.failure', { ...tags, errorCode: error.code || error.name });
    logger.error('Refill status refresh failed', {
      refreshId, count: refills.length, durationMs: Date.now() - startedAt,
      error: error.message, code: error.code, ...tags,
    });
    Sentry.captureException(error, { tags, extra: { refreshId, count: refills.length } });
    throw error;
  } finally {
    clearTimeout(deadline);
    recordTiming('refillqueue.refresh.latency', Date.now() - startedAt, tags);
  }
}

module.exports = { refreshRefillQueue, REFILLS, REFRESH_DEADLINE_MS, STATUS_LOOKUP_MS };
