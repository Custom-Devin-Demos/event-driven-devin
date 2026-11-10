const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { declareDatadogIncident } = require('../datadog-incidents');
const { queueIncidentChannelInvites } = require('../datadog-incident-slack');
const { getOncallSkin } = require('../../../config/oncall-skins');

const SKIN = '5abd65f5';
const SERVICE = 'cibc-interac-delivery';
const ROUTE = '/api/oncall/cibc/etransfer/send';
const RELEASE = 'cibc-interac-delivery@2026.11.3';
const INCIDENT_WINDOW_MS = 5 * 60 * 1000;
const INCIDENT_SEVERITY = 'SEV-1';
const INCIDENT_CHANNEL_PREFIX = 'sev-1-incident';
const BATCH = Object.freeze({ id: 'ET-CAD-2048', contact: 'Avery Cedar', amount: 75, currency: 'CAD', deliveryRail: 'interac_realtime' });
const DELIVERY_ADAPTERS = { interac: { send: async (payment) => ({ success: true, paymentId: payment.id }) } };

function deliveryRailFor(payment) {
  return payment.deliveryRail;
}

async function deliverPayment(payment) {
  const adapter = DELIVERY_ADAPTERS[deliveryRailFor(payment)];
  return adapter.send(payment);
}

let openIncident = null;
let declaringIncident = null;

async function deliveryIncident(triggeredBy) {
  if (openIncident && Date.now() - openIncident.declaredAt < INCIDENT_WINDOW_MS) {
    return { ...openIncident, reused: true };
  }
  if (declaringIncident) return declaringIncident;
  const runRef = `cibc-interac-${uuidv4().slice(0, 8)}`;
  declaringIncident = (async () => {
    try {
      const incident = await declareDatadogIncident({
        title: 'CIBC: Interac e-Transfer delivery outage',
        summary: `Interac e-Transfer send requests return 503 after ${RELEASE}. No funds were sent. Investigate delivery adapter resolution in app/services/oncall-verticals/cibc-etransfer.js only. Quick Transfer is a separate service.`,
        runRef,
        service: SERVICE,
        triggeredBy,
        repoUrl: process.env.ONCALL_REPO_URL || 'https://github.com/COG-GTM/event-driven-devin',
        severity: INCIDENT_SEVERITY,
      });
      if (!incident) return { status: 'unavailable', runRef };
      openIncident = { status: 'declared', ...incident, runRef, channelPrefix: INCIDENT_CHANNEL_PREFIX, declaredAt: Date.now() };
      queueIncidentChannelInvites({ publicId: incident.publicId, userIds: getOncallSkin(SKIN).incidentInviteUserIds });
      logger.info('CIBC Interac delivery incident declared', { service: SERVICE, ...openIncident });
      return openIncident;
    } catch (error) {
      logger.warn('CIBC Interac delivery incident declaration failed', { service: SERVICE, runRef, error: error.message });
      return { status: 'failed', runRef };
    }
  })();
  try {
    return await declaringIncident;
  } finally {
    declaringIncident = null;
  }
}

async function sendMoney({ batchId, devinEmail } = {}) {
  if (batchId !== BATCH.id) {
    return { statusCode: 400, body: { success: false, code: 'INVALID_ETRANSFER', error: 'Choose a CAD contact payment.' } };
  }
  const started = Date.now();
  const requestId = uuidv4();
  try {
    const result = await deliverPayment(BATCH);
    return { statusCode: 200, body: result };
  } catch (error) {
    const tags = { service: SERVICE, route: ROUTE, release: RELEASE };
    incrementMetric('cibc.interac.failure', tags);
    recordTiming('cibc.interac.latency', Date.now() - started, tags);
    logger.error('CIBC Interac delivery engine unavailable', {
      ...tags, requestId, batchId, currency: BATCH.currency,
      statusCode: 503, error: error.message, errorClass: error.name, stack: error.stack,
    });
    Sentry.captureException(error, { tags, extra: { requestId, batchId } });
    const incident = await deliveryIncident(
      typeof devinEmail === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(devinEmail) ? devinEmail : `oncall/c/${SKIN}`
    );
    return {
      statusCode: 503,
      body: {
        success: false,
        code: 'ETRANSFER_UNAVAILABLE',
        error: 'Interac e-Transfer is temporarily unavailable. No money was sent.',
        requestId,
        batch: BATCH,
        incident,
      },
    };
  }
}

module.exports = { BATCH, sendMoney };
