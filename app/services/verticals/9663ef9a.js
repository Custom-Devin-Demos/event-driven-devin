const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { SEVERITY_RULES, normalizeEvent } = require('./9663ef9a-health-rules');

const SERVICE = '9663ef9a-api';
const FLEET = Array.from({ length: 10 }, (_, i) => ({
  id: `HT-${214 + i}`, model: ['793F', '797F', '794 AC'][i % 3],
  autonomous: i >= 6, version: i >= 6 ? 3 : 2,
  smu: 12480 + i * 713, payload: [226, 363, 297][i % 3],
  coolant: [92, 94, 108, 91, 95, 93, 109, 96, 94, 92][i],
  status: [2, 6].includes(i) ? 'Attention' : 'Online',
}));
const BATCH = [
  { truckId: 'HT-216', version: 2, spn: 110, fmi: 0 },
  { truckId: 'HT-218', version: 2, spn: 1761, fmi: 18 },
  { truckId: 'HT-220', version: 3, code: { spn: 110, fmi: 0 } },
  { truckId: 'HT-222', version: 3, code: { spn: 100, fmi: 1 } },
];
let state = { status: 'Ready', error: null, events: [], workOrders: [] };

function getOverview() {
  return { fleet: FLEET, batch: BATCH, kpis: { online: 10, autonomous: 4, openEvents: 4, availability: 96.8 }, ...state };
}

function scoreEvent(event) {
  const rule = SEVERITY_RULES[event.spn];
  return { ...event, score: rule.weight, priority: rule.priority, description: rule.description };
}

function formatWorkOrder(event, index) {
  return { id: `WO-${4810 + index}`, truckId: event.truckId, diagnostic: event.code.toUpperCase(), priority: event.priority };
}

function resetSweep() {
  state = { status: 'Ready', error: null, events: [], workOrders: [] };
  logger.info('Health sweep reset', { service: SERVICE });
  incrementMetric('9663ef9a.sweep.reset', { service: SERVICE });
  return { success: true, ...getOverview() };
}

async function runSweep(data = {}) {
  const requestId = uuidv4();
  const started = Date.now();
  logger.info('Processing telemetry batch', { service: SERVICE, requestId, samples: BATCH.length });
  try {
    await new Promise(resolve => setTimeout(resolve, 70 + Math.random() * 110));
    const events = BATCH.map(normalizeEvent).map(scoreEvent);
    const workOrders = events.map(formatWorkOrder);
    state = { status: 'Completed', error: null, events, workOrders };
    incrementMetric('9663ef9a.sweep.success', { service: SERVICE });
    return { success: true, requestId, ...getOverview() };
  } catch (error) {
    state = { status: 'Failed', error: `${error.name}: ${error.message}`, events: [], workOrders: [] };
    incrementMetric('9663ef9a.sweep.failure', { service: SERVICE });
    logger.error('Health sweep failed', { service: SERVICE, requestId, error: error.message, stack: error.stack });
    Sentry.captureException(error, { tags: { service: SERVICE, alert_path: 'instant' }, extra: { requestId } });
    logger.info('Invoking createSessionAndAlert', { service: SERVICE, requestId });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/`,
      culprit: 'app/services/verticals/9663ef9a.js — runSweep',
      errorType: error.name, errorValue: error.message,
      devinUserId: data.devinUserId, devinOrgId: data.devinOrgId, devinEmail: data.devinEmail,
      service: SERVICE, verticalLabel: 'Surface mine fleet health',
      promptAppendix: 'Investigate the root cause, implement the fix, and include a regression test in the PR. Verify the full sweep and work orders at /9663ef9a. Do not deploy.',
      tags: [{ key: 'service', value: SERVICE }, { key: 'route', value: '/api/9663ef9a/sweep' }],
      extra: { requestId, samples: BATCH.length }, level: 'error', platform: 'node',
      firstSeen: '', lastSeen: new Date().toISOString(), count: '', shortId: '',
      project: 'event-driven-devin', release: process.env.SENTRY_RELEASE || '9663ef9a@1.0.0',
      environment: process.env.DD_ENV || 'prod', triggeredRule: '',
    }).catch(err => logger.error('Session dispatch failed', { service: SERVICE, error: err.message }));
    throw error;
  } finally {
    recordTiming('9663ef9a.sweep.latency', Date.now() - started, { service: SERVICE });
  }
}

module.exports = { getOverview, runSweep, resetSweep, FLEET, BATCH };
