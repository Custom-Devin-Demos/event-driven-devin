const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { FAULT_CODES, decodeFaultEvents } = require('./0eda990f-faults');

const SWEEP_INTERVAL_MINUTES = 60;

const DEALERS = {
  HOLT: {
    code: 'HOLT',
    name: 'Holt',
    region: 'San Antonio, TX',
    escalation: { channel: '#svc-holt-dispatch', slaMinutes: 30, contact: 'Dispatch desk' },
    phone: '+1 210 648 5100',
  },
  ZIEG: {
    code: 'ZIEG',
    name: 'Ziegler',
    region: 'Minneapolis, MN',
    escalation: { channel: '#svc-zieg-dispatch', slaMinutes: 45, contact: 'Service control' },
    phone: '+1 763 788 6601',
  },
  CART: {
    code: 'CART',
    name: 'Carter Machinery',
    region: 'Salem, VA',
    escalation: { channel: '#svc-cart-dispatch', slaMinutes: 30, contact: 'Fleet response' },
    phone: '+1 540 387 9400',
  },
  WAGN: {
    code: 'WAGN',
    name: 'Wagner Equipment',
    region: 'Aurora, CO',
    escalation: { channel: '#svc-wagn-dispatch', slaMinutes: 60, contact: 'Field support' },
    phone: '+1 303 739 3000',
  },
};

const FLEET = [
  { serial: 'DKS10482', model: '336 Hydraulic Excavator', family: 'Excavator', site: 'I-35 corridor widening — Waco TX', dealerCode: 'HOLT', hours: 4120, telematicsDevice: 'PL542', lastReportAt: new Date(Date.now() - 8 * 60 * 1000).toISOString(), status: 'connected' },
  { serial: 'GBX00917', model: 'D6 Dozer', family: 'Dozer', site: 'Roanoke quarry — Roanoke VA', dealerCode: 'CART', hours: 8735, telematicsDevice: 'PL243', lastReportAt: new Date(Date.now() - 12 * 60 * 1000).toISOString(), status: 'connected' },
  { serial: 'SSP02291', model: '793F Mining Truck', family: 'Mining Truck', site: 'Hibbing iron range pit — Hibbing MN', dealerCode: 'ZIEG', hours: 21800, telematicsDevice: 'PL542', lastReportAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(), status: 'connected' },
  { serial: 'M5T03356', model: '950 GC Wheel Loader', family: 'Wheel Loader', site: 'DIA expansion — Denver CO', dealerCode: 'WAGN', hours: 6540, telematicsDevice: 'PL243', lastReportAt: new Date(Date.now() - 17 * 60 * 1000).toISOString(), status: 'connected' },
  { serial: 'N9J01128', model: '140 Motor Grader', family: 'Motor Grader', site: 'I-35 corridor widening — Waco TX', dealerCode: 'HOLT', hours: 12980, telematicsDevice: 'PL542', lastReportAt: new Date(Date.now() - 21 * 60 * 1000).toISOString(), status: 'connected' },
  { serial: 'HEX20144', model: '320 Hydraulic Excavator', family: 'Excavator', site: 'DIA expansion — Denver CO', dealerCode: 'WAGN', hours: 5320, telematicsDevice: 'PL243', lastReportAt: new Date(Date.now() - 4 * 60 * 1000).toISOString(), status: 'connected' },
  { serial: '3T600482', model: '745 Articulated Truck', family: 'Articulated Truck', site: 'Hibbing iron range pit — Hibbing MN', dealerCode: 'ZIEG', hours: 16440, telematicsDevice: 'PL542', lastReportAt: new Date(Date.now() - 9 * 60 * 1000).toISOString(), status: 'connected' },
  { serial: 'RXG00751', model: 'C15 Generator Set', family: 'Generator Set', site: 'Roanoke quarry — Roanoke VA', dealerCode: 'CART', hours: 7210, telematicsDevice: 'PL243', lastReportAt: new Date(Date.now() - 15 * 60 * 1000).toISOString(), status: 'connected' },
];

const FAULT_EVENTS = [
  { eventId: 'FE-110-SSP02291', serial: 'SSP02291', spn: 110, fmi: 0, occurredAt: new Date(Date.now() - 7 * 60 * 1000).toISOString(), hoursAtFault: 21798.4 },
  { eventId: 'FE-100-GBX00917', serial: 'GBX00917', spn: 100, fmi: 1, occurredAt: new Date(Date.now() - 14 * 60 * 1000).toISOString(), hoursAtFault: 8734.8 },
  { eventId: 'FE-3251-SSP02291', serial: 'SSP02291', spn: 3251, fmi: 0, occurredAt: new Date(Date.now() - 19 * 60 * 1000).toISOString(), hoursAtFault: 21797.9 },
  { eventId: 'FE-168-M5T03356', serial: 'M5T03356', spn: 168, fmi: 4, occurredAt: new Date(Date.now() - 27 * 60 * 1000).toISOString(), hoursAtFault: 6539.9 },
  { eventId: 'FE-94-N9J01128', serial: 'N9J01128', spn: 94, fmi: 18, occurredAt: new Date(Date.now() - 33 * 60 * 1000).toISOString(), hoursAtFault: 12979.6 },
  { eventId: 'FE-1761-HEX20144', serial: 'HEX20144', spn: 1761, fmi: 17, occurredAt: new Date(Date.now() - 42 * 60 * 1000).toISOString(), hoursAtFault: 5319.7 },
  { eventId: 'FE-171-HEX20144', serial: 'HEX20144', spn: 171, fmi: 3, occurredAt: new Date(Date.now() - 51 * 60 * 1000).toISOString(), hoursAtFault: 5319.5 },
];

const SWEEPS = [];

function currentWindow() {
  const end = new Date();
  end.setUTCSeconds(0, 0);
  end.setUTCMinutes(Math.floor(end.getUTCMinutes() / 60) * 60);
  return { start: new Date(end.getTime() - SWEEP_INTERVAL_MINUTES * 60 * 1000).toISOString(), end: end.toISOString() };
}

function capSweeps() {
  SWEEPS.splice(20);
}

function triageAsset(asset, decoded) {
  const record = decoded.find((entry) => entry.serial === asset.serial);
  const critical = record.faults.filter((fault) => fault.severity === 'critical');
  const severities = record.faults.map((fault) => fault.severity);
  const highestSeverity = severities.includes('critical') ? 'critical' : severities.includes('warning') ? 'warning' : 'advisory';
  return {
    serial: asset.serial,
    model: asset.model,
    dealerCode: asset.dealerCode,
    faultCount: record.faults.length,
    critical,
    highestSeverity,
    requiresDispatch: critical.length > 0,
  };
}

function buildDispatch(triage, decoded) {
  return triage.filter((entry) => entry.requiresDispatch).map((entry) => {
    const record = decoded.find((item) => item.serial === entry.serial);
    const dealer = DEALERS[record.dealerCode];
    return {
      alertId: `SA-${uuidv4().slice(0, 8).toUpperCase()}`,
      serial: entry.serial,
      model: entry.model,
      dealer: dealer.name,
      channel: dealer.escalation.channel,
      dueBy: new Date(Date.now() + dealer.escalation.slaMinutes * 60 * 1000).toISOString(),
      faults: record.faults.filter((fault) => fault.severity === 'critical').map((fault) => ({
        code: fault.code,
        component: fault.component,
        description: fault.description,
        action: fault.action,
      })),
    };
  });
}

function buildSweepReport(sweepId, window, triage, dispatches) {
  const faults = triage.reduce((sum, asset) => sum + asset.faultCount, 0);
  return {
    sweepId,
    window,
    assetsReporting: triage.length,
    faultsDecoded: faults,
    critical: triage.reduce((sum, asset) => sum + asset.critical.length, 0),
    warnings: triage.filter((asset) => asset.highestSeverity === 'warning').length,
    advisories: triage.filter((asset) => asset.highestSeverity === 'advisory').length,
    alertsDispatched: dispatches.length,
    dispatches,
    triage,
    completedAt: new Date().toISOString(),
  };
}

function sweepStatus() {
  if (SWEEPS.length === 0) return 'standby';
  if (SWEEPS[0].status === 'failed') return 'degraded';
  return 'monitoring';
}

async function runFaultSweep(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const sweepId = `FS-${requestId.slice(0, 8).toUpperCase()}`;
  const window = currentWindow();
  logger.info('Running fault sweep', {
    requestId,
    sweepId,
    window,
    fleet: FLEET.length,
    service: '0eda990f-api',
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));
    const decoded = decodeFaultEvents(FAULT_EVENTS);
    const triage = FLEET.map((asset) => triageAsset(asset, decoded));
    const dispatches = buildDispatch(triage, decoded);
    const report = buildSweepReport(sweepId, window, triage, dispatches);
    SWEEPS.unshift({ ...report, status: 'complete' });
    capSweeps();
    incrementMetric('faultsweep.run.success', { route: '/api/0eda990f/fault-sweep/run' });
    recordTiming('faultsweep.run.latency', Date.now() - startTime, { route: '/api/0eda990f/fault-sweep/run' });
    return { success: true, requestId, report };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('faultsweep.run.failure', {
      route: '/api/0eda990f/fault-sweep/run',
      errorClass: error.name,
    });
    recordTiming('faultsweep.run.latency', duration, {
      route: '/api/0eda990f/fault-sweep/run',
      error: 'true',
    });
    logger.error('Fault sweep failed', {
      requestId,
      sweepId,
      window,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });
    SWEEPS.unshift({
      sweepId,
      window,
      status: 'failed',
      error: `${error.name}: ${error.message}`,
      startedAt: new Date(startTime).toISOString(),
    });
    capSweeps();
    Sentry.captureException(error, {
      tags: {
        route: '/api/0eda990f/fault-sweep/run',
        service: '0eda990f-api',
        alert_path: 'instant',
      },
      extra: { requestId, sweepId, window },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/0eda990f.js — runFaultSweep',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: '0eda990f-api',
      verticalLabel: 'Connected Asset Ops — Critical Fault Sweep',
      slackMemberId: 'U0BDHHQUM24',
      tags: [
        { key: 'route', value: '/api/0eda990f/fault-sweep/run' },
        { key: 'service', value: '0eda990f-api' },
        { key: 'windowEnd', value: window.end },
      ],
      extra: {
        requestId,
        sweepId,
        window,
        fleet: FLEET.map((asset) => asset.serial),
        faultEvents: FAULT_EVENTS.length,
        promptContext: `The hourly critical-fault sweep for the window ending ${window.end} failed before any machine was triaged. ${FLEET.length} connected machines reported ${FAULT_EVENTS.length} fault events in the window, including engine coolant over-temperature and low oil pressure codes; no dealer service alert was dispatched for any of them. Dealer response SLA is 30 minutes from fault detection.`,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: '0eda990f@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'After fixing, add a unit test that runs a fault sweep end-to-end and asserts every machine in the fleet is triaged, every critical fault produces exactly one dealer dispatch with a channel and due-by time, and the totals match the fault events; verify the fix in the browser on /0eda990f.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from fault sweep error', { error: err.message });
    });
    throw error;
  }
}

function resetFaultSweep() {
  const clearedSweeps = SWEEPS.length;
  SWEEPS.length = 0;
  logger.info('Fault sweep re-armed', { clearedSweeps, service: '0eda990f-api' });
  incrementMetric('faultsweep.rearm', { route: '/api/0eda990f/fault-sweep/reset' });
  return { success: true, clearedSweeps, sweep: sweepStatus() };
}

function getOverview() {
  return {
    fleet: FLEET,
    dealers: DEALERS,
    faultEvents: FAULT_EVENTS,
    faultCodes: FAULT_CODES,
    sweeps: SWEEPS,
    window: currentWindow(),
    intervalMinutes: SWEEP_INTERVAL_MINUTES,
    sweep: sweepStatus(),
  };
}

module.exports = { runFaultSweep, resetFaultSweep, getOverview, FLEET, FAULT_EVENTS, DEALERS };
