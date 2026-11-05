const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { declareDatadogIncident } = require('../datadog-incidents');

const SERVICE = 'statestreet-settlement-api';
const ROUTE = '/api/oncall/statestreet/settlement-batches/release';
const RELEASE = 'settlement-router@2026.11.1';
const INCIDENT_WINDOW_MS = 5 * 60 * 1000;
const BATCH = Object.freeze({
  id: 'USD-SET-042',
  paymentCount: 28,
  totalUsd: 1845000,
  currency: 'USD',
  cutoff: '17:00 ET',
  status: 'Awaiting release',
  settlementPool: 'institutional_usd_v2',
});

// The November router rollout moves institutional USD batches onto v2.
const SETTLEMENT_POOLS = {
  institutional_usd_v1: {
    release: async (batch) => ({ success: true, batchId: batch.id, status: 'released' }),
  },
};

let openIncident = null;
let declaringIncident = null;

async function settlementIncident(triggeredBy) {
  if (openIncident && Date.now() - openIncident.declaredAt < INCIDENT_WINDOW_MS) {
    return { ...openIncident, reused: true };
  }
  if (declaringIncident) return declaringIncident;
  const runRef = `ss-settlement-${uuidv4().slice(0, 8)}`;
  declaringIncident = (async () => {
    try {
      const incident = await declareDatadogIncident({
        title: 'State Street: USD settlement gateway unavailable',
        summary: `Institutional USD settlement-batch releases are returning HTTP 503 following ${RELEASE}. All ${BATCH.paymentCount} instructions in batch ${BATCH.id} (${BATCH.totalUsd} USD) remain queued; no payments have been released. The shared settlement route is unavailable and the ${BATCH.cutoff} cutoff is at risk. Individual cash transfers still complete but are slow. Investigate the settlement router and pool registration in app/services/oncall-verticals/statestreet.js.`,
        runRef,
        service: SERVICE,
        triggeredBy,
        repoUrl: process.env.ONCALL_REPO_URL || 'https://github.com/COG-GTM/event-driven-devin',
        severity: 'SEV-1',
      });
      if (!incident) return { status: 'unavailable', runRef };
      openIncident = { status: 'declared', ...incident, runRef, declaredAt: Date.now() };
      logger.info('State Street settlement incident declared', { service: SERVICE, ...openIncident });
      return openIncident;
    } catch (error) {
      logger.warn('State Street settlement incident declaration failed', { service: SERVICE, runRef, error: error.message });
      return { status: 'failed', runRef };
    }
  })();
  try {
    return await declaringIncident;
  } finally {
    declaringIncident = null;
  }
}

async function releaseSettlementBatch({ batchId, devinEmail } = {}) {
  if (batchId !== BATCH.id) {
    return { statusCode: 400, body: { success: false, code: 'INVALID_BATCH', error: 'Choose an available settlement batch.' } };
  }
  const started = Date.now();
  const requestId = uuidv4();
  try {
    const pool = SETTLEMENT_POOLS[BATCH.settlementPool];
    const result = await pool.release(BATCH);
    return { statusCode: 200, body: result };
  } catch (error) {
    const tags = { service: SERVICE, route: ROUTE, release: RELEASE };
    incrementMetric('settlement.batch.failure', tags);
    recordTiming('settlement.batch.latency', Date.now() - started, tags);
    logger.error('State Street settlement gateway unavailable', {
      ...tags, requestId, batchId, settlementPool: BATCH.settlementPool,
      paymentCount: BATCH.paymentCount, totalUsd: BATCH.totalUsd,
      statusCode: 503, error: error.message, errorClass: error.name, stack: error.stack,
    });
    Sentry.captureException(error, { tags, extra: { requestId, batchId } });
    const incident = await settlementIncident(
      typeof devinEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(devinEmail)
        ? devinEmail : 'oncall/c/9440f502'
    );
    return {
      statusCode: 503,
      body: {
        success: false,
        code: 'SETTLEMENT_GATEWAY_UNAVAILABLE',
        error: 'USD settlement is unavailable. The batch remains queued; no payments have been released.',
        requestId,
        batch: BATCH,
        incident,
      },
    };
  }
}

module.exports = { BATCH, releaseSettlementBatch };
