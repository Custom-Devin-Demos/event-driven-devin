const crypto = require('crypto');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');

const DISPATCH_ROUTE = '/api/oncall/emergencydispatch/dispatch';
const SERVICE = 'cop-dispatch-api';

/** Active incidents on the common operational picture (seeded demo data). */
const INCIDENTS = {
  'INC-26-10-0471': {
    id: 'INC-26-10-0471',
    title: 'Wildfire — Sierra de Guadarrama, Cercedilla',
    level: 2,
    plan: 'INFOMA',
  },
};

/** Responding agencies and the tasking gateway each one exposes. */
const AGENCIES = {
  'bomberos-cm': { id: 'bomberos-cm', name: 'Bomberos Comunidad de Madrid', gateway: 'bomberos-cm.tasking.cecop.internal' },
  'forestales-cm': { id: 'forestales-cm', name: 'Agentes Forestales CM', gateway: 'forestales-cm.tasking.cecop.internal' },
  'miteco-aereos': { id: 'miteco-aereos', name: 'MITECO · Medios aéreos', gateway: 'miteco-aereos.tasking.cecop.internal' },
  'summa-112': { id: 'summa-112', name: 'SUMMA 112', gateway: 'summa-112.tasking.cecop.internal' },
  'gc-seprona': { id: 'gc-seprona', name: 'Guardia Civil · SEPRONA', gateway: 'gc-seprona.tasking.cecop.internal' },
  'proteccion-civil': { id: 'proteccion-civil', name: 'Protección Civil · ES-Alert', gateway: 'proteccion-civil.tasking.cecop.internal' },
};

/** Resources that can be tasked from the response plan. */
const RESOURCES = {
  'HU-401': { id: 'HU-401', name: 'Helicopter Kamov', agency: 'forestales-cm', kind: 'aerial' },
  'ACO-23': { id: 'ACO-23', name: 'Canadair CL-415', agency: 'miteco-aereos', kind: 'aerial' },
  'BF-07': { id: 'BF-07', name: 'Forest brigade (8)', agency: 'bomberos-cm', kind: 'ground' },
  'BF-12': { id: 'BF-12', name: 'Forest brigade (6)', agency: 'bomberos-cm', kind: 'ground' },
  'SUM-3': { id: 'SUM-3', name: 'Advanced life support', agency: 'summa-112', kind: 'medical' },
  'PC-SECTOR-B': { id: 'PC-SECTOR-B', name: 'Sector B evacuation pre-alert', agency: 'proteccion-civil', kind: 'alert' },
};

/**
 * Agency tasking endpoints. Under an INFOMA level-2 activation every
 * coordinating agency must acknowledge a dispatch, not just the agencies
 * that own the tasked resources.
 */
const TASKING_ENDPOINTS = {
  'v1/tasking-sync': { latencyMs: [1850, 2000], deprecated: true },
  'v2/tasking': { latencyMs: [60, 140], deprecated: false },
};
const TASKING_ENDPOINT = 'v1/tasking-sync';
const NOTIFY_ALWAYS = Object.keys(AGENCIES);
const DISPATCH_DEADLINE_MS = 9000;

const delay = ([minMs, maxMs]) => new Promise((resolve) => {
  setTimeout(resolve, minMs + Math.random() * (maxMs - minMs));
});

function invalidDispatch(message) {
  const error = new Error(message);
  error.code = 'INVALID_DISPATCH';
  return error;
}

function withDeadline(promise, ms) {
  let timer;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Resource tasking exceeded ${ms}ms`);
      error.code = 'DISPATCH_TIMEOUT';
      reject(error);
    }, ms);
  });
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer));
}

function validateDispatch(data = {}) {
  if (typeof data.incidentId !== 'string' || !Object.hasOwn(INCIDENTS, data.incidentId)) {
    throw invalidDispatch('Select an active incident.');
  }
  if (!Array.isArray(data.resources) || data.resources.length === 0) {
    throw invalidDispatch('Select at least one resource to dispatch.');
  }
  if (data.resources.length > Object.keys(RESOURCES).length) {
    throw invalidDispatch('Too many resources in the response plan.');
  }
  const resources = [];
  for (const id of data.resources) {
    if (typeof id !== 'string' || !Object.hasOwn(RESOURCES, id)) throw invalidDispatch(`Unknown resource: ${String(id).slice(0, 32)}`);
    if (!resources.some((r) => r.id === id)) resources.push(RESOURCES[id]);
  }
  const approver = typeof data.approvedBy === 'string' ? data.approvedBy.trim().slice(0, 120) : '';
  return { incident: INCIDENTS[data.incidentId], resources, approvedBy: approver || 'Duty Operations Officer' };
}

function agenciesFor(resources) {
  const ids = [];
  for (const r of resources) if (!ids.includes(r.agency)) ids.push(r.agency);
  for (const id of NOTIFY_ALWAYS) if (!ids.includes(id)) ids.push(id);
  return ids.map((id) => AGENCIES[id]);
}

async function sendTasking(agency, dispatchId, endpoint) {
  await delay(TASKING_ENDPOINTS[endpoint].latencyMs);
  return { agency: agency.id, dispatchId, ack: `${agency.id.toUpperCase()}-${dispatchId.slice(-4)}` };
}

async function confirmAgencyTasking(agencies, dispatchId, deadlineAt) {
  const endpoint = TASKING_ENDPOINT;
  const acks = [];
  for (const agency of agencies) {
    const startedAt = Date.now();
    try {
      const ack = await withDeadline(sendTasking(agency, dispatchId, endpoint), Math.max(0, deadlineAt - startedAt));
      logger.info('Agency tasking confirmation', {
        dispatchId, agency: agency.id, gateway: agency.gateway, endpoint,
        deprecatedEndpoint: TASKING_ENDPOINTS[endpoint].deprecated,
        durationMs: Date.now() - startedAt, service: SERVICE, route: DISPATCH_ROUTE,
      });
      acks.push(ack);
    } catch (error) {
      logger.info('Agency tasking confirmation', {
        dispatchId, agency: agency.id, gateway: agency.gateway, endpoint,
        deprecatedEndpoint: TASKING_ENDPOINTS[endpoint].deprecated,
        durationMs: Date.now() - startedAt,
        taskingStatus: error.code === 'DISPATCH_TIMEOUT' ? 'timed_out' : 'failed',
        service: SERVICE, route: DISPATCH_ROUTE,
      });
      throw error;
    }
  }
  return acks;
}

async function dispatchResponsePlan(data = {}) {
  const startedAt = Date.now();
  const plan = validateDispatch(data);
  const dispatchId = `DSP-${crypto.randomBytes(2).toString('hex').toUpperCase()}-${plan.incident.id.slice(-4)}`;
  const agencies = agenciesFor(plan.resources);

  try {
    const acks = await confirmAgencyTasking(agencies, dispatchId, startedAt + DISPATCH_DEADLINE_MS);
    const durationMs = Date.now() - startedAt;
    incrementMetric('emergencydispatch.dispatch.success', { route: DISPATCH_ROUTE });
    recordTiming('emergencydispatch.dispatch.latency', durationMs, { route: DISPATCH_ROUTE, service: SERVICE });
    logger.info('Response plan dispatched', { dispatchId, incidentId: plan.incident.id, agencies: agencies.length, durationMs, service: SERVICE, route: DISPATCH_ROUTE });
    return {
      success: true,
      dispatch: {
        id: dispatchId,
        incidentId: plan.incident.id,
        approvedBy: plan.approvedBy,
        resources: plan.resources.map((r) => ({ id: r.id, name: r.name, agency: AGENCIES[r.agency].name })),
        acknowledgements: acks,
      },
      agenciesConfirmed: acks.length,
      durationMs,
    };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    incrementMetric('emergencydispatch.dispatch.failure', { route: DISPATCH_ROUTE, errorClass: error.name });
    recordTiming('emergencydispatch.dispatch.latency', durationMs, { route: DISPATCH_ROUTE, service: SERVICE, error: 'true' });
    logger.error('Response plan dispatch failed', {
      dispatchId, incidentId: plan.incident.id, error: error.message, errorClass: error.name,
      code: error.code, agencies: agencies.length, durationMs, service: SERVICE, route: DISPATCH_ROUTE,
    });
    Sentry.captureException(error, {
      tags: { route: DISPATCH_ROUTE, service: SERVICE },
      extra: { dispatchId, incidentId: plan.incident.id, resources: plan.resources.map((r) => r.id) },
    });
    error.dispatchId = dispatchId;
    throw error;
  }
}

module.exports = {
  dispatchResponsePlan,
  confirmAgencyTasking,
  agenciesFor,
  INCIDENTS,
  AGENCIES,
  RESOURCES,
  TASKING_ENDPOINTS,
  TASKING_ENDPOINT,
  DISPATCH_DEADLINE_MS,
};
