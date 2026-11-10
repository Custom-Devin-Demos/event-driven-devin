const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { declareDatadogIncident } = require('../datadog-incidents');
const { queueIncidentChannelInvites } = require('../datadog-incident-slack');
const { getOncallSkin } = require('../../../config/oncall-skins');

const SKIN = '5922e7ff';
const SERVICE = 'wm-rebalance-engine';
const ROUTE = '/api/oncall/wealthrebalance/submit';
const RELEASE = 'wm-rebalance-engine@2026.11.2';
const INCIDENT_WINDOW_MS = 5 * 60 * 1000;
const BATCH = Object.freeze({
  id: 'RB-GRW7030-1110',
  model: 'Growth 70/30',
  households: 3,
  accounts: 7,
  tradeCount: 42,
  notionalUsd: 4860000,
  window: '15:30 ET block window',
  status: 'Ready to rebalance',
  modelVersion: 'grw-7030@v12',
});

/**
 * Block allocation queues that fan a model rebalance out into account-level
 * trades. The engine selects one from the model's trading profile.
 */
const ALLOCATION_QUEUES = {
  block_alloc_v1: {
    dispatch: async (batch) => ({ success: true, batchId: batch.id, status: 'submitted', tradeCount: batch.tradeCount }),
  },
};

// Model portfolios moved to trading profile v2 in the 2026.11 engine release.
const TRADING_PROFILES = {
  'grw-7030@v12': { allocationQueue: 'block_alloc_v2', blockWindow: '15:30 ET' },
};

let openIncident = null;
let declaringIncident = null;

function allocationQueueFor(batch) {
  return TRADING_PROFILES[batch.modelVersion].allocationQueue;
}

async function dispatchBlockTrades(batch) {
  const queue = ALLOCATION_QUEUES[allocationQueueFor(batch)];
  return queue.dispatch(batch);
}

async function rebalanceIncident(triggeredBy) {
  if (openIncident && Date.now() - openIncident.declaredAt < INCIDENT_WINDOW_MS) {
    return { ...openIncident, reused: true };
  }
  if (declaringIncident) return declaringIncident;
  const runRef = `wm-rebalance-${uuidv4().slice(0, 8)}`;
  declaringIncident = (async () => {
    try {
      const incident = await declareDatadogIncident({
        title: 'Morgan Stanley: Advisor Desk model rebalance outage',
        summary: `Model rebalance submissions are returning HTTP 503 following ${RELEASE}. Rebalance ${BATCH.id} (${BATCH.model}, ${BATCH.households} households, ${BATCH.accounts} accounts, ${BATCH.tradeCount} trades, ${BATCH.notionalUsd} USD notional) was not sent to the block desk; no trades were placed. Every model rebalance is blocked and the ${BATCH.window} is at risk. Single-account order entry is a separate alert. Investigate the rebalance engine's block allocation dispatch in app/services/oncall-verticals/wealthrebalance.js.`,
        runRef,
        service: SERVICE,
        triggeredBy,
        repoUrl: process.env.ONCALL_REPO_URL || 'https://github.com/COG-GTM/event-driven-devin',
        severity: 'SEV-1',
      });
      if (!incident) return { status: 'unavailable', runRef };
      openIncident = { status: 'declared', ...incident, runRef, declaredAt: Date.now() };
      queueIncidentChannelInvites({ publicId: incident.publicId, userIds: getOncallSkin(SKIN).incidentInviteUserIds });
      logger.info('Advisor Desk rebalance incident declared', { service: SERVICE, ...openIncident });
      return openIncident;
    } catch (error) {
      logger.warn('Advisor Desk rebalance incident declaration failed', { service: SERVICE, runRef, error: error.message });
      return { status: 'failed', runRef };
    }
  })();
  try {
    return await declaringIncident;
  } finally {
    declaringIncident = null;
  }
}

async function submitRebalance({ batchId, devinEmail } = {}) {
  if (batchId !== BATCH.id) {
    return { statusCode: 400, body: { success: false, code: 'INVALID_REBALANCE', error: 'Choose a proposed model rebalance.' } };
  }
  const started = Date.now();
  const requestId = uuidv4();
  try {
    const result = await dispatchBlockTrades(BATCH);
    return { statusCode: 200, body: result };
  } catch (error) {
    const tags = { service: SERVICE, route: ROUTE, release: RELEASE };
    incrementMetric('wm.rebalance.failure', tags);
    recordTiming('wm.rebalance.latency', Date.now() - started, tags);
    logger.error('Advisor Desk rebalance engine unavailable', {
      ...tags, requestId, batchId, model: BATCH.model, modelVersion: BATCH.modelVersion,
      tradeCount: BATCH.tradeCount, notionalUsd: BATCH.notionalUsd,
      statusCode: 503, error: error.message, errorClass: error.name, stack: error.stack,
    });
    Sentry.captureException(error, { tags, extra: { requestId, batchId } });
    const incident = await rebalanceIncident(
      typeof devinEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(devinEmail) ? devinEmail : `oncall/c/${SKIN}`
    );
    return {
      statusCode: 503,
      body: {
        success: false,
        code: 'REBALANCE_UNAVAILABLE',
        error: 'Model rebalancing is unavailable. No trades were sent to the block desk.',
        requestId,
        batch: BATCH,
        incident,
      },
    };
  }
}

module.exports = { BATCH, submitRebalance };
