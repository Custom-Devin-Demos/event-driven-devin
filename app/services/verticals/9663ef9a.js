const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { runWithAlertDestination } = require('../alert-destination');
const { adaptTelemetry } = require('./9663ef9a-health-rules');

const SERVICE = '9663ef9a-api';
const FLEET = Array.from({ length: 10 }, (_, i) => ({
  id: `HT-${214 + i}`, model: i >= 6 ? 'Mixed-OEM haul truck' : ['793F', '797F', '794 AC'][i % 3],
  autonomous: i >= 6, firmware: i >= 6 ? '4.7' : 'Site standard',
  smu: 12480 + i * 713, payload: [226, 363, 297][i % 3],
  coolant: [92, 94, 108, 91, 95, 93, 109, 96, 94, 92][i],
  status: 'Running',
}));
const TARGETS = FLEET.filter(truck => truck.autonomous).map(truck => truck.id);
let state = { status: 'Ready', error: null, fleet: FLEET };

function getOverview() {
  const stopped = state.fleet.filter(truck => truck.status !== 'Running').length;
  return { ...state, targets: TARGETS, kpis: { running: 10 - stopped, autonomous: 4, stopped, availability: (10 - stopped) * 10 } };
}

function resetRollout() {
  state = { status: 'Ready', error: null, fleet: FLEET };
  logger.info('Firmware rollout reset', { service: SERVICE });
  incrementMetric('9663ef9a.rollout.reset', { service: SERVICE });
  return { success: true, ...getOverview() };
}

async function runRollout(data = {}) {
  const requestId = uuidv4();
  const started = Date.now();
  logger.info('Starting OEM firmware rollout', { service: SERVICE, requestId, targets: TARGETS });
  try {
    const failures = [];
    const fleet = FLEET.map(truck => {
      if (!truck.autonomous) return truck;
      try {
        adaptTelemetry({ truckId: truck.id, vehicleSpeedKph: 18 });
        return { ...truck, firmware: '4.8' };
      } catch (error) {
        failures.push(error);
        return { ...truck, firmware: '4.8', status: 'Telemetry lost – safe-stopped' };
      }
    });
    state = { status: 'Completed', error: null, fleet };
    if (failures.length) throw new Error(`${failures.length} trucks safe-stopped after OEM firmware rollout. Telemetry adapter could not read vehicle data. Six unaffected trucks remain running.`, { cause: failures[0] });
    incrementMetric('9663ef9a.rollout.success', { service: SERVICE });
    return { success: true, requestId, ...getOverview() };
  } catch (error) {
    const cause = error.cause ? { name: error.cause.name, message: error.cause.message, stack: error.cause.stack } : undefined;
    const errorValue = cause
      ? `${error.message}\nCaused by ${cause.name}: ${cause.message}\n${(cause.stack || '').split('\n').slice(1, 4).join('\n')}`
      : error.message;
    state = { ...state, status: 'Failed', error: error.message };
    incrementMetric('9663ef9a.rollout.failure', { service: SERVICE });
    logger.error('OEM firmware rollout failed', { service: SERVICE, requestId, error: error.message, stack: error.stack, cause });
    Sentry.captureException(error, { tags: { service: SERVICE, alert_path: 'instant' }, extra: { requestId, cause } });
    logger.info('Invoking createSessionAndAlert', { service: SERVICE, requestId, alertDestination: 'teams' });
    runWithAlertDestination('teams', () => createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/`,
      culprit: 'app/services/verticals/9663ef9a.js — runRollout',
      errorType: error.name, errorValue,
      devinUserId: data.devinUserId, devinOrgId: data.devinOrgId, devinEmail: data.devinEmail,
      service: SERVICE, verticalLabel: 'Surface mine fleet health',
      promptAppendix: 'Investigate the root cause, implement the fix, and include a regression test in the PR. Verify the firmware rollout and unaffected fleet at /9663ef9a. Do not deploy.',
      tags: [{ key: 'service', value: SERVICE }, { key: 'route', value: '/api/9663ef9a/rollout' }],
      extra: { requestId, targets: TARGETS, cause }, level: 'error', platform: 'node',
      firstSeen: '', lastSeen: new Date().toISOString(), count: '', shortId: '',
      project: 'event-driven-devin', release: process.env.SENTRY_RELEASE || '9663ef9a@1.0.0',
      environment: process.env.DD_ENV || 'prod', triggeredRule: '',
    })).catch(err => logger.error('Session dispatch failed', { service: SERVICE, error: err.message }));
    throw error;
  } finally {
    recordTiming('9663ef9a.rollout.latency', Date.now() - started, { service: SERVICE });
  }
}

module.exports = { getOverview, runRollout, resetRollout };
