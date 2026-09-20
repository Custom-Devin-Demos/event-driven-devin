const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { readTankGauges } = require('./b4c3a7fc-gauges');

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
    tankIds: ['TK-RCH-310', 'TK-BAY-402', 'TK-LAX-610'],
    status: 'flowing',
  },
];

const NOMINATIONS = [
  { id: 'NOM-260901-014', segmentId: 'SEG-PAS-COL', shipper: 'Marathon Petroleum', product: 'WTI Light Sweet', nominatedBbl: 36200, scheduledBbl: 35000, cycle: '2026-09 C3', status: 'confirmed' },
  { id: 'NOM-260901-015', segmentId: 'SEG-PAS-COL', shipper: 'Phillips 66', product: 'WTI Light Sweet', nominatedBbl: 24800, scheduledBbl: 24400, cycle: '2026-09 C3', status: 'partial' },
  { id: 'NOM-260901-021', segmentId: 'SEG-RCH-BAY', shipper: 'Valero', product: 'ULSD', nominatedBbl: 21600, scheduledBbl: 21600, cycle: '2026-09 C3', status: 'confirmed' },
  { id: 'NOM-260901-022', segmentId: 'SEG-RCH-BAY', shipper: 'Pilot Travel Centers', product: 'CBOB 87', nominatedBbl: 18900, scheduledBbl: 17200, cycle: '2026-09 C3', status: 'partial' },
  { id: 'NOM-260901-028', segmentId: 'SEG-MID-CRN', shipper: 'Permian Basin Producers', product: 'WTL Permian Sour', nominatedBbl: 48200, scheduledBbl: 47000, cycle: '2026-09 C3', status: 'confirmed' },
  { id: 'NOM-260901-029', segmentId: 'SEG-MID-CRN', shipper: 'Refining – Products Supply', product: 'WTI Light Sweet', nominatedBbl: 33400, scheduledBbl: 32600, cycle: '2026-09 C3', status: 'confirmed' },
  { id: 'NOM-260901-034', segmentId: 'SEG-ELS-LAX', shipper: 'Delta Air Lines Fuel', product: 'Jet A', nominatedBbl: 16800, scheduledBbl: 16500, cycle: '2026-09 C3', status: 'confirmed' },
  { id: 'NOM-260901-041', segmentId: 'SEG-SLC-BOI', shipper: 'Refining – Products Supply', product: 'ULSD', nominatedBbl: 14200, scheduledBbl: 13500, cycle: '2026-09 C3', status: 'partial' },
  { id: 'NOM-260901-042', segmentId: 'SEG-SLC-BOI', shipper: 'Pilot Travel Centers', product: 'CBOB 87', nominatedBbl: 11800, scheduledBbl: 11800, cycle: '2026-09 C3', status: 'confirmed' },
];

const BATCH_TICKETS = [
  { ticketId: 'BT-1042-0913-01', segmentId: 'SEG-PAS-COL', nominationId: 'NOM-260901-014', meterId: 'MTR-PAS-01', product: 'WTI Light Sweet', grossBbl: 18420, meterFactor: 1.0012, direction: 'receipt', ticketedAt: '2026-09-13T01:14:00.000Z' },
  { ticketId: 'BT-1042-0913-02', segmentId: 'SEG-PAS-COL', nominationId: 'NOM-260901-014', meterId: 'MTR-COL-01', product: 'WTI Light Sweet', grossBbl: 17980, meterFactor: 0.9994, direction: 'delivery', ticketedAt: '2026-09-13T03:42:00.000Z' },
  { ticketId: 'BT-1042-0913-03', segmentId: 'SEG-PAS-COL', nominationId: 'NOM-260901-015', meterId: 'MTR-PAS-02', product: 'WTI Light Sweet', grossBbl: 12200, meterFactor: 1.0008, direction: 'receipt', ticketedAt: '2026-09-13T04:18:00.000Z' },
  { ticketId: 'BT-1042-0913-04', segmentId: 'SEG-RCH-BAY', nominationId: 'NOM-260901-021', meterId: 'MTR-RCH-01', product: 'ULSD', grossBbl: 15920, meterFactor: 1.0011, direction: 'receipt', ticketedAt: '2026-09-13T00:54:00.000Z' },
  { ticketId: 'BT-1042-0913-05', segmentId: 'SEG-RCH-BAY', nominationId: 'NOM-260901-021', meterId: 'MTR-BAY-01', product: 'ULSD', grossBbl: 15580, meterFactor: 0.9997, direction: 'delivery', ticketedAt: '2026-09-13T02:26:00.000Z' },
  { ticketId: 'BT-1042-0913-06', segmentId: 'SEG-RCH-BAY', nominationId: 'NOM-260901-022', meterId: 'MTR-RCH-02', product: 'CBOB 87', grossBbl: 9200, meterFactor: 1.0006, direction: 'receipt', ticketedAt: '2026-09-13T03:08:00.000Z' },
  { ticketId: 'BT-1042-0913-07', segmentId: 'SEG-MID-CRN', nominationId: 'NOM-260901-028', meterId: 'MTR-MID-01', product: 'WTL Permian Sour', grossBbl: 28600, meterFactor: 1.0015, direction: 'receipt', ticketedAt: '2026-09-13T00:22:00.000Z' },
  { ticketId: 'BT-1042-0913-08', segmentId: 'SEG-MID-CRN', nominationId: 'NOM-260901-029', meterId: 'MTR-CRN-01', product: 'WTI Light Sweet', grossBbl: 27140, meterFactor: 0.9992, direction: 'delivery', ticketedAt: '2026-09-13T02:04:00.000Z' },
  { ticketId: 'BT-1042-0913-09', segmentId: 'SEG-ELS-LAX', nominationId: 'NOM-260901-034', meterId: 'MTR-ELS-01', product: 'Jet A', grossBbl: 11280, meterFactor: 1.0004, direction: 'receipt', ticketedAt: '2026-09-13T01:47:00.000Z' },
  { ticketId: 'BT-1042-0913-10', segmentId: 'SEG-ELS-LAX', nominationId: 'NOM-260901-034', meterId: 'MTR-LAX-01', product: 'Jet A', grossBbl: 11020, meterFactor: 0.9998, direction: 'delivery', ticketedAt: '2026-09-13T03:16:00.000Z' },
  { ticketId: 'BT-1042-0913-11', segmentId: 'SEG-SLC-BOI', nominationId: 'NOM-260901-041', meterId: 'MTR-SLC-01', product: 'ULSD', grossBbl: 9800, meterFactor: 1.001, direction: 'receipt', ticketedAt: '2026-09-13T00:36:00.000Z' },
  { ticketId: 'BT-1042-0913-12', segmentId: 'SEG-SLC-BOI', nominationId: 'NOM-260901-042', meterId: 'MTR-BOI-01', product: 'CBOB 87', grossBbl: 9450, meterFactor: 0.9995, direction: 'delivery', ticketedAt: '2026-09-13T02:52:00.000Z' },
];

const RUNS = [];

function netVolume(ticket) {
  return Math.round(ticket.grossBbl * ticket.meterFactor * 10) / 10;
}

function snapshotInventory(segment) {
  const gauges = readTankGauges(segment.tankIds);
  return segment.tankIds.reduce((inventory, tankId) => ({
    openingBbl: inventory.openingBbl + gauges[tankId].openingBbl,
    closingBbl: inventory.closingBbl + gauges[tankId].closingBbl,
    tankCount: inventory.tankCount + 1,
  }), { openingBbl: 0, closingBbl: 0, tankCount: 0 });
}

function reconcileSegment(segment, tickets, inventory) {
  const receiptsBbl = tickets.filter((ticket) => ticket.direction === 'receipt').reduce((sum, ticket) => sum + netVolume(ticket), 0);
  const deliveriesBbl = tickets.filter((ticket) => ticket.direction === 'delivery').reduce((sum, ticket) => sum + netVolume(ticket), 0);
  const bookChangeBbl = receiptsBbl - deliveriesBbl;
  const physicalChangeBbl = inventory.closingBbl - inventory.openingBbl;
  const varianceBbl = physicalChangeBbl - bookChangeBbl;
  const lossGainPct = varianceBbl / Math.max(receiptsBbl, 1) * 100;
  return {
    segmentId: segment.id,
    segmentName: segment.name,
    receiptsBbl,
    deliveriesBbl,
    bookChangeBbl,
    physicalChangeBbl,
    varianceBbl,
    lossGainPct: Math.round(lossGainPct * 100) / 100,
    status: Math.abs(lossGainPct) <= 0.25 ? 'within-tolerance' : 'investigate',
    ticketCount: tickets.length,
  };
}

function buildMovementReport(runId, gaugeDate, results) {
  return {
    runId,
    gaugeDate,
    publishedAt: new Date().toISOString(),
    segments: results,
    totals: {
      receiptsBbl: results.reduce((sum, result) => sum + result.receiptsBbl, 0),
      deliveriesBbl: results.reduce((sum, result) => sum + result.deliveriesBbl, 0),
      varianceBbl: results.reduce((sum, result) => sum + result.varianceBbl, 0),
    },
    segmentsInvestigate: results.filter((result) => result.status === 'investigate').length,
  };
}

function capRuns() {
  RUNS.splice(20);
}

async function publishDailyMovements(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const runId = `MOV-${requestId.slice(0, 8).toUpperCase()}`;
  const gaugeDate = data.gaugeDate || new Date().toISOString().slice(0, 10);

  logger.info('Publishing daily movements', {
    requestId,
    runId,
    gaugeDate,
    segments: SEGMENTS.length,
    service: 'b4c3a7fc-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));
    const results = SEGMENTS.map((segment) => {
      const inventory = snapshotInventory(segment);
      const tickets = BATCH_TICKETS.filter((ticket) => ticket.segmentId === segment.id);
      return reconcileSegment(segment, tickets, inventory);
    });
    const report = buildMovementReport(runId, gaugeDate, results);
    RUNS.unshift({ ...report, status: 'published' });
    capRuns();
    incrementMetric('movements.publish.success', { route: '/api/b4c3a7fc/movements/publish' });
    recordTiming('movements.publish.latency', Date.now() - startTime, { route: '/api/b4c3a7fc/movements/publish' });
    return { success: true, requestId, report };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('movements.publish.failure', {
      route: '/api/b4c3a7fc/movements/publish',
      errorClass: error.name,
    });
    recordTiming('movements.publish.latency', duration, {
      route: '/api/b4c3a7fc/movements/publish',
      error: 'true',
    });
    logger.error('Daily movements publish failed', {
      requestId,
      runId,
      gaugeDate,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });
    RUNS.unshift({
      runId,
      gaugeDate,
      status: 'failed',
      error: `${error.name}: ${error.message}`,
      startedAt: new Date(startTime).toISOString(),
    });
    capRuns();
    Sentry.captureException(error, {
      tags: {
        route: '/api/b4c3a7fc/movements/publish',
        service: 'b4c3a7fc-api',
      },
      extra: { requestId, runId, gaugeDate },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/b4c3a7fc.js — publishDailyMovements',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: 'b4c3a7fc-api',
      verticalLabel: 'Midstream Pipeline Operations — Daily Movements',
      slackMemberId: 'U0BDHHQUM24',
      tags: [
        { key: 'route', value: '/api/b4c3a7fc/movements/publish' },
        { key: 'service', value: 'b4c3a7fc-api' },
        { key: 'gaugeDate', value: gaugeDate },
      ],
      extra: {
        requestId,
        runId,
        gaugeDate,
        segments: SEGMENTS.map((segment) => segment.id),
        ticketCount: BATCH_TICKETS.length,
        promptContext: `The daily pipeline movements publish for gauge date ${gaugeDate} failed before any segment was reconciled. Until it publishes, terminal operators have no book-vs-physical variance for ${SEGMENTS.length} segments and shipper statements cannot be issued.`,
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
      promptAppendix: 'After fixing, add a unit test that publishes daily movements end-to-end for every segment and asserts each reconciliation carries numeric opening/closing inventory, and verify the fix in the browser on /b4c3a7fc.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from movements publish error', { error: err.message });
    });
    throw error;
  }
}

function getOverview() {
  return {
    segments: SEGMENTS,
    nominations: NOMINATIONS,
    tickets: BATCH_TICKETS.map((ticket) => ({ ...ticket, netBbl: netVolume(ticket) })),
    runs: RUNS,
    gaugeDate: new Date().toISOString().slice(0, 10),
  };
}

module.exports = { publishDailyMovements, getOverview, SEGMENTS, NOMINATIONS, BATCH_TICKETS };
