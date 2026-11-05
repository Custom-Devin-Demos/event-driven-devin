const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { declareDatadogIncident } = require('../datadog-incidents');
const { queueIncidentChannelInvites } = require('../datadog-incident-slack');
const { getOncallSkin } = require('../../../config/oncall-skins');

const SERVICE = 'regions-billpay-api';
const ROUTE = '/api/oncall/regions/bill-pay/submit';
const RELEASE = 'billpay-router@2026.11.1';
const INCIDENT_WINDOW_MS = 5 * 60 * 1000;
const BATCH = Object.freeze({
  id: 'BILLS-042',
  paymentCount: 3,
  totalUsd: 2540,
  currency: 'USD',
  cutoff: '17:00 ET',
  status: 'Ready to pay',
  settlementPool: 'consumer_ach_v2',
});

// The November router rollout moves consumer ACH bill payments onto v2.
const SETTLEMENT_POOLS = {
  consumer_ach_v1: {
    release: async (batch) => ({ success: true, batchId: batch.id, status: 'released' }),
  },
};

let openIncident = null;
let declaringIncident = null;

async function billPayIncident(triggeredBy) {
  if (openIncident && Date.now() - openIncident.declaredAt < INCIDENT_WINDOW_MS) {
    return { ...openIncident, reused: true };
  }
  if (declaringIncident) return declaringIncident;
  const runRef = `regions-billpay-${uuidv4().slice(0, 8)}`;
  declaringIncident = (async () => {
    try {
      const incident = await declareDatadogIncident({
        title: 'Regions Bank: online bill pay outage',
        summary: `Consumer bill-payment submissions are returning HTTP 503 following ${RELEASE}. All ${BATCH.paymentCount} scheduled bills in payment group ${BATCH.id} (${BATCH.totalUsd} USD) remain queued; no payments have been released. The shared bill-pay route is unavailable and the ${BATCH.cutoff} cutoff is at risk. Account balances remain available and individual account transfers still complete but are slow. Investigate the bill-pay router and pool registration in app/services/oncall-verticals/regions.js.`,
        runRef,
        service: SERVICE,
        triggeredBy,
        repoUrl: process.env.ONCALL_REPO_URL || 'https://github.com/COG-GTM/event-driven-devin',
        severity: 'SEV-1',
      });
      if (!incident) return { status: 'unavailable', runRef };
      openIncident = { status: 'declared', ...incident, runRef, declaredAt: Date.now() };
      queueIncidentChannelInvites({
        publicId: incident.publicId,
        userIds: getOncallSkin('5e57909d').incidentInviteUserIds,
      });
      logger.info('Regions Bank bill pay incident declared', { service: SERVICE, ...openIncident });
      return openIncident;
    } catch (error) {
      logger.warn('Regions Bank bill pay incident declaration failed', { service: SERVICE, runRef, error: error.message });
      return { status: 'failed', runRef };
    }
  })();
  try {
    return await declaringIncident;
  } finally {
    declaringIncident = null;
  }
}

async function submitBillPayments({ batchId, devinEmail } = {}) {
  if (batchId !== BATCH.id) {
    return { statusCode: 400, body: { success: false, code: 'INVALID_BATCH', error: 'Choose your scheduled bill payments.' } };
  }
  const started = Date.now();
  const requestId = uuidv4();
  try {
    const pool = SETTLEMENT_POOLS[BATCH.settlementPool];
    const result = await pool.release(BATCH);
    return { statusCode: 200, body: result };
  } catch (error) {
    const tags = { service: SERVICE, route: ROUTE, release: RELEASE };
    incrementMetric('regions.billpay.failure', tags);
    recordTiming('regions.billpay.latency', Date.now() - started, tags);
    logger.error('Regions Bank bill pay gateway unavailable', {
      ...tags, requestId, batchId, settlementPool: BATCH.settlementPool,
      paymentCount: BATCH.paymentCount, totalUsd: BATCH.totalUsd,
      statusCode: 503, error: error.message, errorClass: error.name, stack: error.stack,
    });
    Sentry.captureException(error, { tags, extra: { requestId, batchId } });
    const incident = await billPayIncident(
      typeof devinEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(devinEmail)
        ? devinEmail : 'oncall/c/5e57909d'
    );
    return {
      statusCode: 503,
      body: {
        success: false,
        code: 'BILL_PAY_UNAVAILABLE',
        error: 'Online bill pay is unavailable. Your bills remain scheduled; no payments have been sent.',
        requestId,
        batch: BATCH,
        incident,
      },
    };
  }
}

module.exports = { BATCH, submitBillPayments };
