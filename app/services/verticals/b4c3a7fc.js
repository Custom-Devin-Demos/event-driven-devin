const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { readTankGauges } = require('./b4c3a7fc-gauges');

const WINDOW_MINUTES = 5;

const SEGMENTS = [
  {
    id: 'SEG-PAS-COL',
    name: 'Pascagoula – Collins 20-in Crude',
    origin: 'Pascagoula Refinery',
    destination: 'Collins Terminal',
    diameterIn: 20,
    lengthMi: 68,
    maxRateBph: 42000,
    product: 'Crude',
    tankIds: ['TK-PAS-101', 'TK-PAS-102', 'TK-COL-201'],
    status: 'flowing',
  },
  {
    id: 'SEG-RCH-BAY',
    name: 'Richmond – Bay Area Products',
    origin: 'Richmond Rack',
    destination: 'Bay Area Terminals',
    diameterIn: 16,
    lengthMi: 42,
    maxRateBph: 31500,
    product: 'ULSD / Gasoline',
    tankIds: ['TK-RCH-310', 'TK-RCH-311', 'TK-BAY-402'],
    status: 'flowing',
  },
  {
    id: 'SEG-MID-CRN',
    name: 'Midland – Crane Permian Gathering',
    origin: 'Midland Central Battery',
    destination: 'Crane Hub',
    diameterIn: 24,
    lengthMi: 94,
    maxRateBph: 56000,
    product: 'Crude',
    tankIds: ['TK-MID-510', 'TK-CRN-520'],
    status: 'flowing',
  },
  {
    id: 'SEG-ELS-LAX',
    name: 'El Segundo – LAX Jet A',
    origin: 'El Segundo Refinery',
    destination: 'LAX Fuel Farm',
    diameterIn: 12,
    lengthMi: 18,
    maxRateBph: 18500,
    product: 'Jet A',
    tankIds: ['TK-ELS-601', 'TK-LAX-610'],
    status: 'flowing',
  },
  {
    id: 'SEG-SLC-BOI',
    name: 'Salt Lake – Boise Products',
    origin: 'Salt Lake Terminal',
    destination: 'Boise Terminal',
    diameterIn: 14,
    lengthMi: 343,
    maxRateBph: 22500,
    product: 'Gasoline / ULSD',
    tankIds: ['TK-SLC-701', 'TK-BOI-710'],
    status: 'flowing',
  },
];

const METER_READINGS = [
  { meterId: 'MTR-PAS-01', segmentId: 'SEG-PAS-COL', station: 'Pascagoula Station 1', role: 'inlet', flowBph: 38400, windowBbl: 3200.0, pressurePsig: 1180, tempF: 78.9 },
  { meterId: 'MTR-COL-01', segmentId: 'SEG-PAS-COL', station: 'Collins Terminal', role: 'outlet', flowBph: 37920, windowBbl: 3160.0, pressurePsig: 615, tempF: 77.6 },
  { meterId: 'MTR-RCH-01', segmentId: 'SEG-RCH-BAY', station: 'Richmond Rack', role: 'inlet', flowBph: 29400, windowBbl: 2450.0, pressurePsig: 940, tempF: 71.4 },
  { meterId: 'MTR-BAY-01', segmentId: 'SEG-RCH-BAY', station: 'Bay Area Terminal', role: 'outlet', flowBph: 29016, windowBbl: 2418.0, pressurePsig: 388, tempF: 72.1 },
  { meterId: 'MTR-MID-01', segmentId: 'SEG-MID-CRN', station: 'Midland Central Battery', role: 'inlet', flowBph: 51600, windowBbl: 4300.0, pressurePsig: 1320, tempF: 84.6 },
  { meterId: 'MTR-CRN-01', segmentId: 'SEG-MID-CRN', station: 'Crane Hub', role: 'outlet', flowBph: 51144, windowBbl: 4262.0, pressurePsig: 702, tempF: 83.9 },
  { meterId: 'MTR-ELS-01', segmentId: 'SEG-ELS-LAX', station: 'El Segundo Refinery', role: 'inlet', flowBph: 16800, windowBbl: 1400.0, pressurePsig: 860, tempF: 69.2 },
  { meterId: 'MTR-LAX-01', segmentId: 'SEG-ELS-LAX', station: 'LAX Fuel Farm', role: 'outlet', flowBph: 16656, windowBbl: 1388.0, pressurePsig: 412, tempF: 69.0 },
  { meterId: 'MTR-SLC-01', segmentId: 'SEG-SLC-BOI', station: 'Salt Lake Terminal', role: 'inlet', flowBph: 20400, windowBbl: 1700.0, pressurePsig: 1410, tempF: 66.5 },
  { meterId: 'MTR-BOI-01', segmentId: 'SEG-SLC-BOI', station: 'Boise Terminal', role: 'outlet', flowBph: 20148, windowBbl: 1679.0, pressurePsig: 505, tempF: 65.4 },
];

const CYCLES = [];

function capCycles() {
  CYCLES.splice(20);
}

function currentWindow() {
  const end = new Date();
  end.setUTCSeconds(0, 0);
  end.setUTCMinutes(Math.floor(end.getUTCMinutes() / WINDOW_MINUTES) * WINDOW_MINUTES);
  const start = new Date(end.getTime() - WINDOW_MINUTES * 60 * 1000);
  return { start: start.toISOString(), end: end.toISOString() };
}

function snapshotTankInventory(segment) {
  const gauges = readTankGauges(segment.tankIds);
  return segment.tankIds.reduce((inventory, tankId) => ({
    startBbl: inventory.startBbl + gauges[tankId].startBbl,
    endBbl: inventory.endBbl + gauges[tankId].endBbl,
    tankCount: inventory.tankCount + 1,
  }), { startBbl: 0, endBbl: 0, tankCount: 0 });
}

function balanceSegment(segment, meters, inventory) {
  const inBbl = meters.filter((meter) => meter.role === 'inlet').reduce((sum, meter) => sum + meter.windowBbl, 0);
  const outBbl = meters.filter((meter) => meter.role === 'outlet').reduce((sum, meter) => sum + meter.windowBbl, 0);
  const tankDeltaBbl = inventory.endBbl - inventory.startBbl;
  const imbalanceBbl = Math.round((inBbl - outBbl - tankDeltaBbl) * 10) / 10;
  const imbalancePct = Math.round(imbalanceBbl / Math.max(inBbl, 1) * 100 * 100) / 100;
  const absolutePct = Math.abs(imbalancePct);
  const status = absolutePct <= 0.5 ? 'normal' : absolutePct <= 1.0 ? 'watch' : 'alarm';
  return {
    segmentId: segment.id,
    segmentName: segment.name,
    inBbl,
    outBbl,
    startBbl: inventory.startBbl,
    endBbl: inventory.endBbl,
    tankDeltaBbl,
    imbalanceBbl,
    imbalancePct,
    status,
    meterCount: meters.length,
  };
}

function buildCycleReport(cycleId, window, results) {
  return {
    cycleId,
    window,
    completedAt: new Date().toISOString(),
    segments: results,
    totals: {
      inBbl: results.reduce((sum, result) => sum + result.inBbl, 0),
      outBbl: results.reduce((sum, result) => sum + result.outBbl, 0),
      imbalanceBbl: results.reduce((sum, result) => sum + result.imbalanceBbl, 0),
    },
    alarms: results.filter((result) => result.status !== 'normal').length,
  };
}

function detectionStatus() {
  if (CYCLES.length === 0) return 'standby';
  if (CYCLES[0].status === 'failed') return 'degraded';
  return 'monitoring';
}

async function runLineBalanceCycle(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const cycleId = `LB-${requestId.slice(0, 8).toUpperCase()}`;
  const window = currentWindow();

  logger.info('Running line-balance cycle', {
    requestId,
    cycleId,
    window,
    segments: SEGMENTS.length,
    service: 'b4c3a7fc-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));
    const results = SEGMENTS.map((segment) => balanceSegment(
      segment,
      METER_READINGS.filter((meter) => meter.segmentId === segment.id),
      snapshotTankInventory(segment),
    ));
    const report = buildCycleReport(cycleId, window, results);
    CYCLES.unshift({ ...report, status: 'complete' });
    capCycles();
    incrementMetric('linebalance.cycle.success', { route: '/api/b4c3a7fc/line-balance/run' });
    recordTiming('linebalance.cycle.latency', Date.now() - startTime, { route: '/api/b4c3a7fc/line-balance/run' });
    return { success: true, requestId, report };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('linebalance.cycle.failure', {
      route: '/api/b4c3a7fc/line-balance/run',
      errorClass: error.name,
    });
    recordTiming('linebalance.cycle.latency', duration, {
      route: '/api/b4c3a7fc/line-balance/run',
      error: 'true',
    });
    logger.error('Line-balance cycle failed', {
      requestId,
      cycleId,
      window,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });
    CYCLES.unshift({
      cycleId,
      window,
      status: 'failed',
      error: `${error.name}: ${error.message}`,
      startedAt: new Date(startTime).toISOString(),
    });
    capCycles();
    Sentry.captureException(error, {
      tags: {
        route: '/api/b4c3a7fc/line-balance/run',
        service: 'b4c3a7fc-api',
        alert_path: 'instant',
      },
      extra: { requestId, cycleId, window },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b4c3a7fc.js — runLineBalanceCycle',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'b4c3a7fc-api',
      verticalLabel: 'Midstream Pipeline Control — Line Balance Leak Detection',
      slackMemberId: 'U0BDHHQUM24',
      tags: [
        { key: 'route', value: '/api/b4c3a7fc/line-balance/run' },
        { key: 'service', value: 'b4c3a7fc-api' },
        { key: 'windowEnd', value: window.end },
      ],
      extra: {
        requestId,
        cycleId,
        window,
        segments: SEGMENTS.map((segment) => segment.id),
        meterCount: METER_READINGS.length,
        promptContext: `The ${WINDOW_MINUTES}-minute line-balance cycle for the window ending ${window.end} failed before any segment was balanced. Computational leak detection is blind on ${SEGMENTS.length} pipeline segments until a cycle completes; control-room procedure escalates to pressure reduction if detection is not restored within 15 minutes.`,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'b4c3a7fc@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'After fixing, add a unit test that runs a line-balance cycle end-to-end for every segment and asserts each result carries numeric start/end tank inventory and a finite imbalance percentage, and verify the fix in the browser on /b4c3a7fc.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from line-balance cycle error', { error: err.message });
    });
    throw error;
  }
}

function getOverview() {
  return {
    segments: SEGMENTS,
    meters: METER_READINGS,
    cycles: CYCLES,
    window: currentWindow(),
    windowMinutes: WINDOW_MINUTES,
    detection: detectionStatus(),
  };
}

module.exports = { runLineBalanceCycle, getOverview, SEGMENTS, METER_READINGS };
