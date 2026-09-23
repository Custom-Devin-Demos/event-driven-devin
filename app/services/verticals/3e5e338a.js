const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { parseUpload } = require('./3e5e338a-parser');

const CURRENT_SHIFT = 'B';

const LINES = [
  { id: 'LINE-01', name: 'Line 1 — Micro-Lock Plus', site: 'Lisle, IL', businessUnit: 'CSBU (copper)', partNumber: '5051100892', stations: ['TS-01-A', 'TS-01-B'], targetFpy: 98.0 },
  { id: 'LINE-02', name: 'Line 2 — NearStack PCIe', site: 'Guadalajara, MX', businessUnit: 'CSBU (cable assemblies)', partNumber: '2047560071', stations: ['TS-02-A'], targetFpy: 97.0 },
  { id: 'LINE-03', name: 'Line 3 — 800G QSFP-DD', site: 'Fremont, CA', businessUnit: 'OptoE (optical)', partNumber: '2028700504', stations: ['TS-03-A', 'TS-03-B'], targetFpy: 95.0 },
];

const STATIONS = [
  { id: 'TS-01-A', lineId: 'LINE-01', type: 'LCR / contact resistance', firmware: '4.1.3', lastHeartbeat: '2026-09-23T00:52:10Z' },
  { id: 'TS-01-B', lineId: 'LINE-01', type: 'LCR / contact resistance', firmware: '4.1.3', lastHeartbeat: '2026-09-23T00:58:41Z' },
  { id: 'TS-02-A', lineId: 'LINE-02', type: 'VNA insertion loss', firmware: '4.1.3', lastHeartbeat: '2026-09-23T00:55:07Z' },
  { id: 'TS-03-A', lineId: 'LINE-03', type: 'Optical TX / BER', firmware: '4.1.3', lastHeartbeat: '2026-09-23T00:49:33Z' },
  { id: 'TS-03-B', lineId: 'LINE-03', type: 'Optical TX / BER', firmware: '4.2.0', lastHeartbeat: '2026-09-23T01:01:58Z' },
];

const SPECS = {
  5051100892: {
    description: 'Micro-Lock Plus 1.25mm Wire-to-Board Header, 6 ckt',
    parameters: [
      { name: 'contact_resistance_mohm', label: 'Contact resistance', unit: 'mΩ', lsl: 0, usl: 20 },
      { name: 'insertion_force_n', label: 'Insertion force', unit: 'N', lsl: 3, usl: 15 },
    ],
  },
  2047560071: {
    description: 'NearStack PCIe Gen5 Cable Assembly, 0.5m',
    parameters: [
      { name: 'insertion_loss_db', label: 'Insertion loss @16GHz', unit: 'dB', lsl: 0, usl: 3.5 },
      { name: 'contact_resistance_mohm', label: 'Contact resistance', unit: 'mΩ', lsl: 0, usl: 12 },
    ],
  },
  2028700504: {
    description: '800G QSFP-DD DR8 Optical Transceiver',
    parameters: [
      { name: 'tx_power_dbm', label: 'TX optical power', unit: 'dBm', lsl: -2.0, usl: 4.0 },
      { name: 'ber', label: 'Pre-FEC bit error rate', unit: '', lsl: 0, usl: 0.000000000001 },
      { name: 'eye_margin_ps', label: 'Eye margin', unit: 'ps', lsl: 12, usl: 40 },
    ],
  },
};

const PENDING_UPLOADS = [
  {
    id: 'UPL-L01-0923-B',
    lineId: 'LINE-01',
    stationId: 'TS-01-B',
    firmware: '4.1.3',
    format: 'CSV',
    fileName: 'TS-01-B_2026-09-23_shiftB_0058.csv',
    receivedAt: '2026-09-23T00:58:41Z',
    rows: [
      { serial_number: 'MX5051-2609-00417', part_number: '5051100892', station_id: 'TS-01-B', line_id: 'LINE-01', shift: 'B', operator: 'J. Alvarez', tested_at: '2026-09-23T00:51:02Z', contact_resistance_mohm: '11.4', insertion_force_n: '8.2' },
      { serial_number: 'MX5051-2609-00418', part_number: '5051100892', station_id: 'TS-01-B', line_id: 'LINE-01', shift: 'B', operator: 'J. Alvarez', tested_at: '2026-09-23T00:52:14Z', contact_resistance_mohm: '12.1', insertion_force_n: '7.9' },
      { serial_number: 'MX5051-2609-00419', part_number: '5051100892', station_id: 'TS-01-B', line_id: 'LINE-01', shift: 'B', operator: 'J. Alvarez', tested_at: '2026-09-23T00:53:30Z', contact_resistance_mohm: '23.6', insertion_force_n: '8.4' },
      { serial_number: 'MX5051-2609-00420', part_number: '5051100892', station_id: 'TS-01-B', line_id: 'LINE-01', shift: 'B', operator: 'J. Alvarez', tested_at: '2026-09-23T00:54:47Z', contact_resistance_mohm: '10.8', insertion_force_n: '9.1' },
      { serial_number: 'MX5051-2609-00421', part_number: '5051100892', station_id: 'TS-01-B', line_id: 'LINE-01', shift: 'B', operator: 'J. Alvarez', tested_at: '2026-09-23T00:56:01Z', contact_resistance_mohm: '11.9', insertion_force_n: '8.0' },
      { serial_number: 'MX5051-2609-00422', part_number: '5051100892', station_id: 'TS-01-B', line_id: 'LINE-01', shift: 'B', operator: 'J. Alvarez', tested_at: '2026-09-23T00:57:19Z', contact_resistance_mohm: '12.7', insertion_force_n: '8.6' },
    ],
  },
  {
    id: 'UPL-L03-0923-B',
    lineId: 'LINE-03',
    stationId: 'TS-03-B',
    firmware: '4.2.0',
    format: 'JSON',
    fileName: 'TS-03-B_2026-09-23_shiftB_0101.json',
    receivedAt: '2026-09-23T01:01:58Z',
    rows: [
      { serial_number: 'MX2028-2609-01204', part_number: '2028700504', station_id: 'TS-03-B', line_id: 'LINE-03', shift: 'B', operator: 'P. Nguyen', tested_at: '2026-09-23T00:48:12Z', tx_power_dbm: '1.84', ber: '1.2E-12', eye_margin_ps: '21.6' },
      { serial_number: 'MX2028-2609-01205', part_number: '2028700504', station_id: 'TS-03-B', line_id: 'LINE-03', shift: 'B', operator: 'P. Nguyen', tested_at: '2026-09-23T00:49:40Z', tx_power_dbm: '2.07', ber: '8.7E-13', eye_margin_ps: '23.1' },
      { serial_number: 'MX2028-2609-01206', part_number: '2028700504', station_id: 'TS-03-B', line_id: 'LINE-03', shift: 'B', operator: 'P. Nguyen', tested_at: '2026-09-23T00:51:03Z', tx_power_dbm: 'N/A', ber: 'N/A', eye_margin_ps: 'N/A' },
      { serial_number: 'MX2028-2609-01207', part_number: '2028700504', station_id: 'TS-03-B', line_id: 'LINE-03', shift: 'B', operator: 'P. Nguyen', tested_at: '2026-09-23T00:52:27Z', tx_power_dbm: '1.62', ber: '3.4E-13', eye_margin_ps: '19.8' },
      { serial_number: 'MX2028-2609-01208', part_number: '2028700504', station_id: 'TS-03-B', line_id: 'LINE-03', shift: 'B', operator: 'P. Nguyen', tested_at: '2026-09-23T00:53:55Z', tx_power_dbm: '2.31', ber: '4.9E-12', eye_margin_ps: '17.2' },
      { serial_number: 'MX2028-2609-01209', part_number: '2028700504', station_id: 'TS-03-B', line_id: 'LINE-03', shift: 'B', operator: 'P. Nguyen', tested_at: '2026-09-23T00:55:18Z', tx_power_dbm: '1.95', ber: '6.1E-13', eye_margin_ps: '22.4' },
      { serial_number: 'MX2028-2609-01210', part_number: '2028700504', station_id: 'TS-03-B', line_id: 'LINE-03', shift: 'B', operator: 'P. Nguyen', tested_at: '2026-09-23T00:56:44Z', tx_power_dbm: '2.14', ber: '9.3E-13', eye_margin_ps: '24.0' },
      { serial_number: 'MX2028-2609-01211', part_number: '2028700504', station_id: 'TS-03-B', line_id: 'LINE-03', shift: 'B', operator: 'P. Nguyen', tested_at: '2026-09-23T00:58:06Z', tx_power_dbm: '1.77', ber: '1.1E-12', eye_margin_ps: '20.5' },
    ],
  },
];

const BASELINE_YIELD = {
  'LINE-01': { tested: 1248, passed: 1228 },
  'LINE-02': { tested: 692, passed: 672 },
  'LINE-03': { tested: 416, passed: 401 },
};

const UPLOADS = [];
const UNITS = [];

class UnknownBatchError extends Error {
  constructor(batchId) {
    super(`No pending upload batch with id ${JSON.stringify(batchId)}`);
    this.name = 'UnknownBatchError';
    this.statusCode = 404;
  }
}

function capHistory() {
  UPLOADS.splice(30).forEach((evicted) => {
    for (let i = UNITS.length - 1; i >= 0; i -= 1) {
      if (UNITS[i].batchId === evicted.batchId) UNITS.splice(i, 1);
    }
  });
}

function replaceBatchState(batchId, receipt, units) {
  const previous = UPLOADS.find((upload) => upload.batchId === batchId);
  for (let i = UPLOADS.length - 1; i >= 0; i -= 1) {
    if (UPLOADS[i].batchId === batchId) UPLOADS.splice(i, 1);
  }
  for (let i = UNITS.length - 1; i >= 0; i -= 1) {
    if (UNITS[i].batchId === batchId) UNITS.splice(i, 1);
  }
  receipt.attempts = (previous ? previous.attempts : 0) + 1;
  UPLOADS.unshift(receipt);
  UNITS.unshift(...units);
  capHistory();
}

function evaluateMeasurement(parameter, value) {
  const rounded = Number(value.toFixed(12));
  const result = rounded >= parameter.lsl && rounded <= parameter.usl ? 'pass' : 'fail';
  return { name: parameter.name, label: parameter.label, unit: parameter.unit, value: rounded, lsl: parameter.lsl, usl: parameter.usl, result };
}

function gradeUnit(unit) {
  const spec = SPECS[unit.partNumber];
  if (!spec) {
    throw new RangeError(`No spec limits registered for part number ${unit.partNumber}`);
  }
  const results = spec.parameters.map((parameter) => evaluateMeasurement(parameter, unit.measurements[parameter.name]));
  return {
    ...unit,
    description: spec.description,
    results,
    status: results.every((entry) => entry.result === 'pass') ? 'pass' : 'fail',
  };
}

function computeYield(units) {
  const tested = units.length;
  const passed = units.filter((unit) => unit.status === 'pass').length;
  return { tested, passed, failed: tested - passed, fpy: tested ? Math.round((passed / tested) * 10000) / 100 : null };
}

function lineYield(lineId) {
  const base = BASELINE_YIELD[lineId];
  const shiftUnits = UNITS.filter((unit) => unit.lineId === lineId);
  const shift = computeYield(shiftUnits);
  const failedUpload = UPLOADS.find((upload) => upload.lineId === lineId && upload.status === 'failed');
  const quarantined = failedUpload ? failedUpload.rowCount : 0;
  return {
    lineId,
    shift: { ...shift, fpy: failedUpload ? 0 : shift.fpy },
    trailing: { tested: base.tested + shift.tested, passed: base.passed + shift.passed, fpy: Math.round(((base.passed + shift.passed) / (base.tested + shift.tested)) * 10000) / 100 },
    quarantined,
    status: failedUpload ? 'quarantine' : shiftUnits.length ? 'shipping' : 'awaiting-upload',
  };
}

function platformStatus() {
  if (UPLOADS.length === 0) return 'idle';
  if (UPLOADS.some((upload) => upload.status === 'failed')) return 'degraded';
  return 'healthy';
}

function formatUploadReceipt(uploadId, batch, units, startTime) {
  return {
    uploadId,
    batchId: batch.id,
    lineId: batch.lineId,
    stationId: batch.stationId,
    firmware: batch.firmware,
    fileName: batch.fileName,
    format: batch.format,
    rowCount: batch.rows.length,
    status: 'ingested',
    yield: computeYield(units),
    startedAt: new Date(startTime).toISOString(),
    completedAt: new Date().toISOString(),
  };
}

async function ingestUpload(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const uploadId = `ING-${requestId.slice(0, 8).toUpperCase()}`;
  const batch = PENDING_UPLOADS.find((upload) => upload.id === data.batchId);
  if (!batch) throw new UnknownBatchError(data.batchId);

  logger.info('Ingesting test-station upload', {
    requestId,
    uploadId,
    batchId: batch.id,
    lineId: batch.lineId,
    stationId: batch.stationId,
    firmware: batch.firmware,
    rows: batch.rows.length,
    service: '3e5e338a-api',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));
    const spec = SPECS[LINES.find((line) => line.id === batch.lineId).partNumber];
    const parsed = parseUpload(batch, spec.parameters.map((parameter) => parameter.name));
    const graded = parsed.map((unit) => ({ ...gradeUnit(unit), batchId: batch.id }));
    const receipt = formatUploadReceipt(uploadId, batch, graded, startTime);
    replaceBatchState(batch.id, receipt, graded);
    incrementMetric('teststation.ingest.success', { route: '/api/3e5e338a/results/upload', line: batch.lineId });
    recordTiming('teststation.ingest.latency', Date.now() - startTime, { route: '/api/3e5e338a/results/upload' });
    return { success: true, requestId, receipt, units: graded };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('teststation.ingest.failure', {
      route: '/api/3e5e338a/results/upload',
      line: batch.lineId,
      errorClass: error.name,
    });
    recordTiming('teststation.ingest.latency', duration, {
      route: '/api/3e5e338a/results/upload',
      error: 'true',
    });
    logger.error('Test-station upload ingest failed', {
      requestId,
      uploadId,
      batchId: batch.id,
      lineId: batch.lineId,
      stationId: batch.stationId,
      firmware: batch.firmware,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
    });
    replaceBatchState(batch.id, {
      uploadId,
      batchId: batch.id,
      lineId: batch.lineId,
      stationId: batch.stationId,
      firmware: batch.firmware,
      fileName: batch.fileName,
      format: batch.format,
      rowCount: batch.rows.length,
      status: 'failed',
      error: `${error.name}: ${error.message}`,
      startedAt: new Date(startTime).toISOString(),
    }, []);
    Sentry.captureException(error, {
      tags: {
        route: '/api/3e5e338a/results/upload',
        service: '3e5e338a-api',
        line: batch.lineId,
        station_firmware: batch.firmware,
        alert_path: 'instant',
      },
      extra: { requestId, uploadId, batchId: batch.id, fileName: batch.fileName },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/3e5e338a.js — ingestUpload',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: '3e5e338a-api',
      verticalLabel: 'Test Station Data Platform — Results Ingest',
      slackMemberId: 'U0BDHHQUM24',
      tags: [
        { key: 'route', value: '/api/3e5e338a/results/upload' },
        { key: 'service', value: '3e5e338a-api' },
        { key: 'line', value: batch.lineId },
        { key: 'station', value: batch.stationId },
        { key: 'station_firmware', value: batch.firmware },
      ],
      extra: {
        requestId,
        uploadId,
        batchId: batch.id,
        fileName: batch.fileName,
        format: batch.format,
        rowCount: batch.rows.length,
        sampleRow: batch.rows[0],
        promptContext: `The results upload from test station ${batch.stationId} (firmware ${batch.firmware}) on ${batch.lineId} failed during ingest, so none of its ${batch.rows.length} units received a pass/fail disposition. Units without a disposition are held in quarantine and the line cannot ship until the upload is accepted. Uploads from stations on firmware 4.1.3 continue to ingest normally.`,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '3e5e338a@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'After fixing, add a regression test that ingests the exact failing payload from the alert and asserts every unit receives a disposition, with a measurement the station did not take recorded as not-tested rather than as a pass; run the full test suite and verify the fix in the browser on /3e5e338a.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from upload ingest error', { error: err.message });
    });
    throw error;
  }
}

function resetIngest() {
  const cleared = UPLOADS.length;
  UPLOADS.length = 0;
  UNITS.length = 0;
  logger.info('Test-station ingest state reset', { clearedUploads: cleared, service: '3e5e338a-api' });
  incrementMetric('teststation.ingest.reset', { route: '/api/3e5e338a/results/upload/reset' });
  return { success: true, clearedUploads: cleared, status: platformStatus() };
}

function getOverview() {
  return {
    shift: CURRENT_SHIFT,
    lines: LINES.map((line) => ({ ...line, yield: lineYield(line.id) })),
    stations: STATIONS,
    specs: SPECS,
    pendingUploads: PENDING_UPLOADS.map((upload) => ({
      id: upload.id,
      lineId: upload.lineId,
      stationId: upload.stationId,
      firmware: upload.firmware,
      format: upload.format,
      fileName: upload.fileName,
      receivedAt: upload.receivedAt,
      rowCount: upload.rows.length,
      preview: upload.rows.slice(0, 3),
    })),
    uploads: UPLOADS,
    units: UNITS.slice(0, 40),
    status: platformStatus(),
  };
}

module.exports = { ingestUpload, resetIngest, getOverview, UnknownBatchError, LINES, STATIONS, SPECS, PENDING_UPLOADS };
