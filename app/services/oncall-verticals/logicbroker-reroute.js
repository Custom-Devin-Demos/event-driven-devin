const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { declareDatadogIncident } = require('../datadog-incidents');
const { queueIncidentChannelInvites } = require('../datadog-incident-slack');
const { getOncallSkin } = require('../../../config/oncall-skins');

const SKIN = '9b95c6e1';
const SERVICE = 'lb-sla-reroute';
const ROUTE = '/api/oncall/logicbroker/reroute';
const RELEASE = 'lb-sla-reroute@2026.11.3';
const INCIDENT_WINDOW_MS = 5 * 60 * 1000;
const INCIDENT_SEVERITY = 'SEV-1';
const INCIDENT_CHANNEL_PREFIX = 'sev-1-incident';
const BATCH = Object.freeze({ id: 'LB-SLA-2048', supplier: 'NorthBridge Home Goods', orderCount: 6, failoverProfile: 'supplier_failover_v2' });
const FAILOVER_ADAPTERS = { supplier_failover: { reroute: async (batch) => ({ success: true, batchId: batch.id }) } };

function failoverProfileFor(batch) {
  return batch.failoverProfile;
}

async function routeAtRiskBatch(batch) {
  const adapter = FAILOVER_ADAPTERS[failoverProfileFor(batch)];
  return adapter.reroute(batch);
}

let openIncident = null;
let declaringIncident = null;

async function reroutingIncident(triggeredBy) {
  if (openIncident && Date.now() - openIncident.declaredAt < INCIDENT_WINDOW_MS) {
    return { ...openIncident, reused: true };
  }
  if (declaringIncident) return declaringIncident;
  const runRef = `lb-reroute-${uuidv4().slice(0, 8)}`;
  declaringIncident = (async () => {
    try {
      const incident = await declareDatadogIncident({
        title: 'Logicbroker: supplier outage blocks SLA rerouting',
        summary: `SLA reroute requests return 503 after ${RELEASE}. No supplier orders were released. Investigate supplier failover adapter resolution in app/services/oncall-verticals/logicbroker-reroute.js only. Routing release is a separate service.`,
        runRef,
        service: SERVICE,
        triggeredBy,
        repoUrl: process.env.ONCALL_REPO_URL || 'https://github.com/COG-GTM/event-driven-devin',
        severity: INCIDENT_SEVERITY,
      });
      if (!incident) return { status: 'unavailable', runRef };
      openIncident = { status: 'declared', ...incident, runRef, channelPrefix: INCIDENT_CHANNEL_PREFIX, declaredAt: Date.now() };
      queueIncidentChannelInvites({ publicId: incident.publicId, userIds: getOncallSkin(SKIN).incidentInviteUserIds });
      logger.info('Logicbroker SLA rerouting incident declared', { service: SERVICE, ...openIncident });
      return openIncident;
    } catch (error) {
      logger.warn('Logicbroker SLA rerouting incident declaration failed', { service: SERVICE, runRef, error: error.message });
      return { status: 'failed', runRef };
    }
  })();
  try {
    return await declaringIncident;
  } finally {
    declaringIncident = null;
  }
}

async function rerouteOrders({ batchId, devinEmail } = {}) {
  if (batchId !== BATCH.id) {
    return { statusCode: 400, body: { success: false, code: 'INVALID_REROUTE', error: 'Choose the at-risk order batch.' } };
  }
  const started = Date.now();
  const requestId = uuidv4();
  try {
    const result = await routeAtRiskBatch(BATCH);
    return { statusCode: 200, body: result };
  } catch (error) {
    const tags = { service: SERVICE, route: ROUTE, release: RELEASE };
    incrementMetric('logicbroker.reroute.failure', tags);
    recordTiming('logicbroker.reroute.latency', Date.now() - started, tags);
    logger.error('Logicbroker SLA rerouting engine unavailable', {
      ...tags, requestId, batchId, orderCount: BATCH.orderCount,
      statusCode: 503, error: error.message, errorClass: error.name, stack: error.stack,
    });
    Sentry.captureException(error, { tags, extra: { requestId, batchId } });
    const incident = await reroutingIncident(
      typeof devinEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(devinEmail) ? devinEmail : `oncall/c/${SKIN}`
    );
    return {
      statusCode: 503,
      body: {
        success: false,
        code: 'REROUTE_UNAVAILABLE',
        error: 'Supplier rerouting is unavailable. All six orders remain blocked.',
        requestId,
        batch: BATCH,
        incident,
      },
    };
  }
}

module.exports = { BATCH, rerouteOrders };
