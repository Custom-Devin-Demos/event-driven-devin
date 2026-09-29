const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  SYSTEM_SITUATION,
  formatServicePoint,
  searchServicePoints,
  findServicePoint,
  loadCircuitSnapshot,
} = require('./b6f570dc-grid');

const ROUTE = '/api/b6f570dc/outage-status';
const SERVICE = 'b6f570dc-api';
const HISTORY_LIMIT = 25;

const LOOKUP_HISTORY = [];

class ServicePointNotFoundError extends Error {
  constructor(address) {
    super(`No service point matches "${address}"`);
    this.name = 'ServicePointNotFoundError';
    this.statusCode = 404;
  }
}

function summarizeCounty(county) {
  return {
    name: county.name,
    withPower: `${county.withPower}%`,
    currentOutages: county.currentOutages,
    customersAffected: county.customersAffected,
  };
}

function derivePowerState(snapshot, servicePoint) {
  const affecting = snapshot.activeOutages.filter((outage) => outage.premiseIds.includes(servicePoint.premiseId));
  if (affecting.length === 0) {
    return { status: 'ON', headline: 'Power is on', outage: null };
  }
  const [outage] = affecting;
  return { status: 'OUT', headline: 'Power is out', outage };
}

function composeStatusView(servicePoint) {
  const snapshot = loadCircuitSnapshot(servicePoint.circuitId);
  return {
    address: formatServicePoint(servicePoint),
    premiseId: servicePoint.premiseId,
    circuit: {
      id: servicePoint.circuitId,
      division: snapshot.circuit.division,
    },
    power: derivePowerState(snapshot, servicePoint),
    psps: { active: snapshot.pspsEvents.length > 0, events: snapshot.pspsEvents },
    county: summarizeCounty(snapshot.county),
    asOf: snapshot.asOf,
  };
}

function recordLookup(entry) {
  LOOKUP_HISTORY.unshift(entry);
  if (LOOKUP_HISTORY.length > HISTORY_LIMIT) LOOKUP_HISTORY.length = HISTORY_LIMIT;
}

async function getOutageStatus(data) {
  const startTime = Date.now();
  const requestId = uuidv4();

  logger.info('Looking up outage status', {
    requestId,
    address: data.address,
    service: SERVICE,
  });

  const servicePoint = findServicePoint(data.address);
  if (!servicePoint) {
    incrementMetric('outage_status.not_found', { route: ROUTE });
    throw new ServicePointNotFoundError(data.address);
  }

  try {
    await new Promise((resolve) => setTimeout(resolve, 60 + Math.random() * 90));

    const view = composeStatusView(servicePoint);
    const duration = Date.now() - startTime;

    recordLookup({ requestId, address: view.address, status: view.power.status, at: new Date().toISOString() });

    incrementMetric('outage_status.success', {
      route: ROUTE,
      division: view.circuit.division,
      status: view.power.status,
    });
    recordTiming('outage_status.latency', duration, { route: ROUTE });

    return { success: true, requestId, ...view };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('outage_status.failure', {
      route: ROUTE,
      errorClass: error.name,
    });
    recordTiming('outage_status.latency', duration, {
      route: ROUTE,
      error: 'true',
    });

    logger.error('Outage status lookup failed', {
      requestId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      address: data.address,
      premiseId: servicePoint.premiseId,
      circuitId: servicePoint.circuitId,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE,
        service: SERVICE,
        alert_path: 'instant',
      },
      extra: {
        requestId,
        address: data.address,
        premiseId: servicePoint.premiseId,
        circuitId: servicePoint.circuitId,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b6f570dc.js — composeStatusView',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Utility Outage Center',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
      ],
      extra: {
        requestId,
        address: data.address,
        premiseId: servicePoint.premiseId,
        circuitId: servicePoint.circuitId,
      },
      promptAppendix: data.sourcePage
        ? `The user-facing page that triggered this error is ${data.sourcePage} — after fixing, verify the fix end-to-end on the same page.`
        : undefined,
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'b6f570dc@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message });
    });

    throw error;
  }
}

function resetOutageStatus() {
  LOOKUP_HISTORY.length = 0;
  logger.info('Outage status lookup history cleared', { service: SERVICE });
  return { success: true, history: [] };
}

module.exports = {
  getOutageStatus,
  resetOutageStatus,
  searchServicePoints,
  ServicePointNotFoundError,
  LOOKUP_HISTORY,
  SYSTEM_SITUATION,
};
