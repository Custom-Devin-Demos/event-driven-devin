const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { declareDatadogIncident } = require('../datadog-incidents');
const { queueIncidentChannelInvites } = require('../datadog-incident-slack');
const { getOncallSkin } = require('../../../config/oncall-skins');

const SKIN = 'db261a21';
const SERVICE = 'walmart-pickup-slot-service';
const ROUTE = '/api/oncall/walmartfulfillment/pickup-slots/reserve';
const RELEASE = 'pickup-slots@2026.11.5';
const INCIDENT_WINDOW_MS = 5 * 60 * 1000;
const INCIDENT_SEVERITY = 'SEV-1';
const INCIDENT_CHANNEL_PREFIX = 'sev-1-incident';

/**
 * Store whose pickup schedule is offered on the cart page. The holiday
 * schedule moves the store onto the `opd-holiday-v2` capacity pool.
 */
const STORE = Object.freeze({
  id: 'STORE-4108',
  name: 'Maple Grove Supercenter',
  capacityPool: 'opd-holiday-v2',
  slots: Object.freeze(['today-1700', 'today-1800', 'tomorrow-0900', 'tomorrow-1000']),
});

/**
 * Order-pickup capacity pools registered with the slot allocator.
 */
const CAPACITY_POOLS = {
  'opd-standard': { reserve: async (slotId) => ({ slotId, holdMinutes: 30 }) },
  'opd-express': { reserve: async (slotId) => ({ slotId, holdMinutes: 15 }) },
};

function capacityPoolFor(store) {
  return CAPACITY_POOLS[store.capacityPool];
}

async function holdSlot(store, slotId) {
  const pool = capacityPoolFor(store);
  return pool.reserve(slotId);
}

let openIncident = null;
let declaringIncident = null;

async function pickupIncident(triggeredBy) {
  if (openIncident && Date.now() - openIncident.declaredAt < INCIDENT_WINDOW_MS) {
    return { ...openIncident, reused: true };
  }
  if (declaringIncident) return declaringIncident;
  const runRef = `walmart-pickup-${uuidv4().slice(0, 8)}`;
  declaringIncident = (async () => {
    try {
      const incident = await declareDatadogIncident({
        title: 'Walmart: Store pickup slot reservations unavailable',
        summary: `Pickup slot reservations from the cart return 503 after ${RELEASE}; customers cannot switch orders to store pickup. Investigate capacity pool resolution in app/services/oncall-verticals/walmartfulfillment.js only. Cart order placement is a separate service.`,
        runRef,
        service: SERVICE,
        triggeredBy,
        repoUrl: process.env.ONCALL_REPO_URL || 'https://github.com/COG-GTM/event-driven-devin',
        severity: INCIDENT_SEVERITY,
      });
      if (!incident) return { status: 'unavailable', runRef };
      openIncident = { status: 'declared', ...incident, runRef, channelPrefix: INCIDENT_CHANNEL_PREFIX, declaredAt: Date.now() };
      queueIncidentChannelInvites({ publicId: incident.publicId, userIds: getOncallSkin(SKIN).incidentInviteUserIds });
      logger.info('Walmart pickup slot incident declared', { service: SERVICE, ...openIncident });
      return openIncident;
    } catch (error) {
      logger.warn('Walmart pickup slot incident declaration failed', { service: SERVICE, runRef, error: error.message });
      return { status: 'failed', runRef };
    }
  })();
  try {
    return await declaringIncident;
  } finally {
    declaringIncident = null;
  }
}

async function reservePickupSlot({ storeId, slotId, devinEmail } = {}) {
  if (storeId !== STORE.id || !STORE.slots.includes(slotId)) {
    return { statusCode: 400, body: { success: false, code: 'INVALID_PICKUP_SLOT', error: 'Choose an available pickup time.' } };
  }
  const started = Date.now();
  const requestId = uuidv4();
  const tags = { service: SERVICE, route: ROUTE, release: RELEASE };
  try {
    const hold = await holdSlot(STORE, slotId);
    incrementMetric('walmart.pickup.reserve.success', tags);
    return { statusCode: 200, body: { success: true, storeId: STORE.id, store: STORE.name, ...hold } };
  } catch (error) {
    incrementMetric('walmart.pickup.reserve.failure', tags);
    recordTiming('walmart.pickup.reserve.latency', Date.now() - started, tags);
    logger.error('Pickup slot allocator unavailable', {
      ...tags, requestId, storeId, slotId, capacityPool: STORE.capacityPool,
      statusCode: 503, error: error.message, errorClass: error.name, stack: error.stack,
    });
    Sentry.captureException(error, { tags, extra: { requestId, storeId, slotId } });
    const incident = await pickupIncident(
      typeof devinEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(devinEmail) ? devinEmail : `oncall/c/${SKIN}`
    );
    return {
      statusCode: 503,
      body: {
        success: false,
        code: 'PICKUP_UNAVAILABLE',
        error: 'Store pickup is temporarily unavailable. Your order is still set to shipping.',
        requestId,
        storeId: STORE.id,
        incident,
      },
    };
  }
}

module.exports = { STORE, reservePickupSlot };
