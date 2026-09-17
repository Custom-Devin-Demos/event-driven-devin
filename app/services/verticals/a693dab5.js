const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { OPERATOR_SCHEMAS, getOperatorSchema } = require('./a693dab5-operator-schemas');
const THRESHOLDS = require('./a693dab5-thresholds.json');

const SERVICE = 'a693dab5-api';
const STAGES = ['ingest', 'normalize', 'compute_health', 'evaluate_exceedances', 'publish'];
const STALE_AFTER_MS = Number(process.env.A693DAB5_STALE_AFTER_MS) || 24 * 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = Number(process.env.A693DAB5_ALERT_COOLDOWN_MS) || 24 * 60 * 60 * 1000;
const ENGINES = {};
const EXCEEDANCES = [];
const SNAPSHOTS = {};
const RUNS = [];
const MAX_RUNS = 500;
const MAX_RUNS_PAGE = 200;
const failureTimestamps = [];
const consecutiveFailures = {};
const lastAlerts = {};
const lastSuccessfulPublishes = {};
let schedulerHandle = null;

const ENGINE_SEEDS = {
  SWA: [
    ['598-2041', 'N8701Q', '737 MAX 8', 1],
    ['598-2042', 'N8701Q', '737 MAX 8', 2],
    ['598-2058', 'N8722Q', '737 MAX 8', 1],
    ['598-2059', 'N8722Q', '737 MAX 8', 2],
    ['598-2070', 'N8740Q', '737 MAX 8', 1],
    ['598-2071', 'N8740Q', '737 MAX 8', 2],
    ['598-2084', 'N8755Q', '737 MAX 8', 1],
    ['598-2085', 'N8755Q', '737 MAX 8', 2],
  ],
  DLH: [
    ['956-3011', 'D-ABYA', '787-9', 1],
    ['956-3012', 'D-ABYA', '787-9', 2],
    ['956-3024', 'D-ABYB', '787-9', 1],
    ['956-3025', 'D-ABYB', '787-9', 2],
    ['956-3036', 'D-ABYC', '787-9', 1],
    ['956-3037', 'D-ABYC', '787-9', 2],
  ],
  QFA: [
    ['706-4101', 'VH-QFA', '747-400F', 1],
    ['706-4102', 'VH-QFA', '747-400F', 2],
    ['706-4113', 'VH-QFB', '767-300', 1],
    ['706-4114', 'VH-QFB', '767-300', 2],
  ],
  MPX: [
    ['598-5101', 'N301MP', 'A320neo', 1],
    ['598-5102', 'N301MP', 'A320neo', 2],
    ['598-5113', 'N322MP', 'A320neo', 1],
    ['598-5114', 'N322MP', 'A320neo', 2],
  ],
};

function mulberry32(seed) {
  let value = seed >>> 0;
  return () => {
    value += 0x6D2B79F5;
    let result = Math.imul(value ^ value >>> 15, 1 | value);
    result ^= result + Math.imul(result ^ result >>> 7, 61 | result);
    return ((result ^ result >>> 14) >>> 0) / 4294967296;
  };
}

function round(value, places = 2) {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function sourceValue(schema, canonical, value) {
  return { [schema.columns[canonical]]: value };
}

function buildEngine(esn, aircraftReg, aircraftType, position, schema, now, random) {
  const baseEgt = 36 + random() * 5;
  const baseVibration = 1.1 + random() * 0.7;
  const baseOil = 0.12 + random() * 0.08;
  const egtMarginHistory = Array.from({ length: 12 }, (_, index) => round(
    baseEgt + index * 0.12 - random() * 0.7,
  ));
  return {
    esn,
    operatorCode: schema.code,
    family: schema.engineFamily,
    aircraftReg,
    aircraftType,
    position,
    egtMarginHistory,
    egtMarginC: egtMarginHistory[egtMarginHistory.length - 1],
    vibrationN1: round(baseVibration),
    vibrationN2: round(baseVibration + 0.2),
    oilPressureKpa: round(270 + random() * 20),
    oilConsumptionQtHr: round(baseOil),
    altitudeFt: 35000,
    lastDataReceivedAt: new Date(now).toISOString(),
  };
}

function clearStore() {
  Object.keys(ENGINES).forEach((key) => delete ENGINES[key]);
  Object.keys(SNAPSHOTS).forEach((key) => delete SNAPSHOTS[key]);
  EXCEEDANCES.splice(0, EXCEEDANCES.length);
  RUNS.splice(0, RUNS.length);
  failureTimestamps.splice(0, failureTimestamps.length);
  Object.keys(consecutiveFailures).forEach((key) => delete consecutiveFailures[key]);
  Object.keys(lastAlerts).forEach((key) => delete lastAlerts[key]);
  Object.keys(lastSuccessfulPublishes).forEach((key) => delete lastSuccessfulPublishes[key]);
}

function pruneFailureTimestamps(now) {
  const cutoff = now - 24 * 60 * 60 * 1000;
  while (failureTimestamps.length && failureTimestamps[0] < cutoff) failureTimestamps.shift();
}

function recordRun(run, { prepend = false } = {}) {
  if (prepend) RUNS.unshift(run);
  else RUNS.push(run);
  RUNS.length = Math.min(RUNS.length, MAX_RUNS);
  if (run.status === 'failed') {
    failureTimestamps.push(Date.parse(run.finishedAt));
    pruneFailureTimestamps(Date.now());
  }
  return run;
}

function addSeedRun({
  schema,
  trigger,
  status,
  stageReached,
  rowsIn,
  rowsOut,
  startedAt,
  error,
  random,
}) {
  const runId = `run-${Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0')}`;
  const durationMs = status === 'succeeded'
    ? 640 + Math.floor(random() * 811)
    : 1500 + Math.floor(random() * 901);
  const run = {
    runId,
    operatorCode: schema.code,
    operatorName: schema.name,
    trigger,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(startedAt + durationMs).toISOString(),
    durationMs,
    stageReached,
    status,
    rowsIn,
    rowsOut,
    error,
  };
  return recordRun(run);
}

function seedSnapshots(schema, engine, now, random) {
  const latest = new Date(engine.lastDataReceivedAt).getTime();
  return Array.from({ length: 8 }, (_, index) => {
    const timestamp = schema.code === 'MPX'
      ? now - (26 * 60 * 60 * 1000) - ((7 - index) * 3 * 60 * 60 * 1000)
      : index === 7
        ? latest
        : now - ((7 - index) * 3 * 60 * 60 * 1000 + 5 * 60 * 1000);
    const receivedAt = new Date(timestamp).toISOString();
    const historyValue = engine.egtMarginHistory[Math.min(engine.egtMarginHistory.length - 1, index + 4)];
    const isLatest = index === 7;
    const vibrationN1 = engine.esn === '956-3011'
      ? (isLatest ? 2.4 : round(2.3 + random() * 0.1))
      : (isLatest ? engine.vibrationN1 : round(engine.vibrationN1 + (random() - 0.5) * 0.12));
    const egtMarginC = isLatest ? engine.egtMarginC : round(historyValue + (random() - 0.5) * 0.3);
    const flightNumber = 1000 + ((index * 137 + engine.esn.length * 19) % 9000);
    return {
      flightDate: receivedAt,
      legId: `${schema.code}${flightNumber}-L1`,
      aircraftReg: engine.aircraftReg,
      esn: engine.esn,
      egtMarginC,
      vibrationN1,
      vibrationN2: isLatest ? engine.vibrationN2 : round(vibrationN1 + 0.2),
      oilPressureKpa: isLatest ? engine.oilPressureKpa : round(engine.oilPressureKpa + (random() - 0.5) * 6),
      oilConsumptionQtHr: isLatest
        ? engine.oilConsumptionQtHr
        : round(engine.oilConsumptionQtHr + (random() - 0.5) * 0.03),
      altitudeFt: 31000 + Math.floor(random() * 8001),
      operatorCode: schema.code,
      family: schema.engineFamily,
      receivedAt,
    };
  });
}

function seedStore(now = Date.now()) {
  clearStore();
  const random = mulberry32(0xa693dab5);
  Object.values(OPERATOR_SCHEMAS).forEach((schema) => {
    const operatorEngines = ENGINE_SEEDS[schema.code];
    operatorEngines.forEach(([esn, aircraftReg, aircraftType, position]) => {
      const engineNow = schema.code === 'MPX'
        ? now - 26 * 60 * 60 * 1000
        : now - 5 * 60 * 1000 - Math.floor(random() * 4 * 60 * 1000);
      ENGINES[esn] = buildEngine(esn, aircraftReg, aircraftType, position, schema, engineNow, random);
      SNAPSHOTS[esn] = [];
    });

    if (schema.code !== 'MPX') {
      let latestSeededRun = null;
      for (let index = 0; index < 8; index += 1) {
        const startedAt = now - ((7 - index) * 3 * 60 * 60 * 1000 + 5 * 60 * 1000);
        latestSeededRun = addSeedRun({
          schema,
          trigger: 'scheduled',
          status: 'succeeded',
          stageReached: 'publish',
          rowsIn: operatorEngines.length * 2,
          rowsOut: operatorEngines.length * 2,
          startedAt,
          error: null,
          random,
        });
      }
      lastSuccessfulPublishes[schema.code] = latestSeededRun
        ? new Date(latestSeededRun.finishedAt).getTime()
        : null;
    } else {
      const seededSuccess = addSeedRun({
        schema,
        trigger: 'scheduled',
        status: 'succeeded',
        stageReached: 'publish',
        rowsIn: operatorEngines.length * 2,
        rowsOut: operatorEngines.length * 2,
        startedAt: now - 26 * 60 * 60 * 1000,
        error: null,
        random,
      });
      lastSuccessfulPublishes[schema.code] = new Date(seededSuccess.finishedAt).getTime();
      [9, 6, 3].forEach((hoursAgo) => addSeedRun({
        schema,
        trigger: 'scheduled',
        status: 'failed',
        stageReached: 'normalize',
        rowsIn: operatorEngines.length * 2,
        rowsOut: 0,
        startedAt: now - hoursAgo * 60 * 60 * 1000,
        error: {
          name: 'TypeError',
          message: "Cannot read properties of undefined (reading 'toCanonical')",
          stage: 'normalize',
        },
        random,
      }));
      consecutiveFailures.MPX = 3;
    }
  });

  const swa = ENGINES['598-2041'];
  swa.egtMarginC = 18;
  swa.egtMarginHistory = Array.from({ length: 12 }, (_, index) => {
    if (index === 11) return 18;
    return round(34 - index * 1.45 - (index ? (index % 2 ? 0.12 : 0) : 0));
  });
  EXCEEDANCES.push({
    id: 'EXC-1041',
    esn: swa.esn,
    detectedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    metric: 'egtMarginC',
    level: 'CAUTION',
    value: 18,
    threshold: THRESHOLDS[swa.family].egtMarginC.caution,
    status: 'open',
  });
  const dlh = ENGINES['956-3011'];
  dlh.vibrationN1 = 2.4;
  EXCEEDANCES.push({
    id: 'EXC-1042',
    esn: dlh.esn,
    detectedAt: new Date(now - 5 * 60 * 1000).toISOString(),
    metric: 'vibrationN1',
    level: 'ADVISORY',
    value: 2.4,
    threshold: THRESHOLDS[dlh.family].vibrationN1.advisory,
    status: 'open',
  });
  Object.values(OPERATOR_SCHEMAS).forEach((schema) => {
    ENGINE_SEEDS[schema.code].forEach(([esn]) => {
      SNAPSHOTS[esn] = seedSnapshots(schema, ENGINES[esn], now, random);
    });
  });
}

function ingestSnapshots(schema, now) {
  const rows = [];
  const exportUnits = schema.unitSystem || {};
  ENGINE_SEEDS[schema.code].forEach(([esn, aircraftReg]) => {
    const engineNumber = esn.split('').reduce((total, character) => total + character.charCodeAt(0), 0);
    const legCount = 2 + (engineNumber % 3);
    for (let leg = 1; leg <= legCount; leg += 1) {
      const engine = ENGINES[esn];
      const flightDate = new Date(now - (legCount - leg) * 95 * 60 * 1000).toISOString();
      const egtMarginC = engine.egtMarginC + (Math.random() * 1.2 - 0.6);
      const vibrationN1 = engine.vibrationN1 + (Math.random() * 0.16 - 0.08);
      const vibrationN2 = engine.vibrationN2 + (Math.random() * 0.16 - 0.08);
      const oilPressureKpa = engine.oilPressureKpa + (Math.random() * 12 - 6);
      const oilConsumptionQtHr = engine.oilConsumptionQtHr + (Math.random() * 0.04 - 0.02);
      const altitudeFt = Math.round((31000 + Math.random() * 8000) / 100) * 100;
      const flightNumber = 1000 + ((Math.floor(now / 60000) + engineNumber + leg * 17) % 9000);
      const source = {
        ...sourceValue(schema, 'flightDate', flightDate),
        ...sourceValue(schema, 'legId', `${schema.code}${flightNumber}-L${leg}`),
        ...sourceValue(schema, 'aircraftReg', aircraftReg),
        ...sourceValue(schema, 'esn', esn),
        ...sourceValue(
          schema,
          'egtMarginC',
          exportUnits.temperature === 'degF' ? (egtMarginC * 9) / 5 + 32 : egtMarginC,
        ),
        ...sourceValue(schema, 'vibrationN1', vibrationN1),
        ...sourceValue(schema, 'vibrationN2', vibrationN2),
        ...sourceValue(
          schema,
          'oilPressureKpa',
          exportUnits.pressure === 'psi' ? oilPressureKpa / 6.894757 : oilPressureKpa,
        ),
        ...sourceValue(schema, 'oilConsumptionQtHr', oilConsumptionQtHr),
        ...sourceValue(schema, 'altitudeFt', altitudeFt),
      };
      rows.push(source);
    }
  });
  return { rows, rowsIn: rows.length };
}

const UNIT_CONVERTERS = {
  egt: {
    C: { toCanonical: (value) => value },
    F: { toCanonical: (value) => (value - 32) * 5 / 9 },
  },
  oilPressure: {
    kPa: { toCanonical: (value) => value },
    psi: { toCanonical: (value) => value * 6.894757 },
  },
};

function resolveUnits(schema) {
  return schema.units || {};
}

function convertReading(metric, value, units) {
  return UNIT_CONVERTERS[metric][units[metric]].toCanonical(value);
}

function normalizeSnapshots(schema, rawRows) {
  const units = resolveUnits(schema);
  return rawRows.map((raw) => {
    const normalized = {};
    Object.keys(schema.columns).forEach((canonical) => {
      normalized[canonical] = raw[schema.columns[canonical]];
    });
    normalized.egtMarginC = convertReading('egt', normalized.egtMarginC, units);
    normalized.oilPressureKpa = convertReading('oilPressure', normalized.oilPressureKpa, units);
    normalized.operatorCode = schema.code;
    normalized.family = schema.engineFamily;
    normalized.receivedAt = new Date().toISOString();
    return normalized;
  });
}

function computeHealth(normalizedRows) {
  const byEngine = {};
  normalizedRows.forEach((row) => {
    if (!byEngine[row.esn]) byEngine[row.esn] = [];
    byEngine[row.esn].push(row);
  });
  return Object.entries(byEngine).map(([esn, rows]) => {
    const latest = rows[rows.length - 1];
    const previous = ENGINES[esn];
    const egtMarginC = rows.reduce((sum, row) => sum + row.egtMarginC, 0) / rows.length;
    return {
      esn,
      family: latest.family,
      operatorCode: latest.operatorCode,
      egtMarginC: round(egtMarginC),
      egtMarginTrend: round(egtMarginC - (previous ? previous.egtMarginC : egtMarginC)),
      vibrationN1: round(latest.vibrationN1),
      vibrationDelta: round(latest.vibrationN1 - (previous ? previous.vibrationN1 : latest.vibrationN1)),
      vibrationN2: round(latest.vibrationN2),
      oilPressureKpa: round(latest.oilPressureKpa),
      oilConsumptionQtHr: round(latest.oilConsumptionQtHr),
      altitudeFt: latest.altitudeFt,
      rows,
    };
  });
}

function levelForMetric(threshold, metric, value) {
  if (!threshold) return null;
  const lowerIsWorse = metric === 'egtMarginC';
  if ((lowerIsWorse && value < threshold.warning) || (!lowerIsWorse && value > threshold.warning)) return 'WARNING';
  if ((lowerIsWorse && value < threshold.caution) || (!lowerIsWorse && value > threshold.caution)) return 'CAUTION';
  if ((lowerIsWorse && value < threshold.advisory) || (!lowerIsWorse && value > threshold.advisory)) return 'ADVISORY';
  return null;
}

function evaluateExceedances(engineMetrics, now = Date.now()) {
  const metrics = Array.isArray(engineMetrics) ? engineMetrics : [engineMetrics];
  const found = [];
  metrics.filter(Boolean).forEach((engine) => {
    const familyThresholds = THRESHOLDS[engine.family];
    if (!familyThresholds) return;
    ['egtMarginC', 'vibrationN1', 'oilConsumptionQtHr'].forEach((metric) => {
      const level = levelForMetric(familyThresholds[metric], metric, engine[metric]);
      if (!level) return;
      const levelKey = level.toLowerCase();
      found.push({
        id: `EXC-${String(EXCEEDANCES.length + found.length + 1041).padStart(4, '0')}`,
        esn: engine.esn,
        detectedAt: new Date(now).toISOString(),
        metric,
        level,
        value: engine[metric],
        threshold: familyThresholds[metric][levelKey],
        status: 'open',
      });
    });
  });
  return found;
}

function publish(schema, normalizedRows, engineMetrics, exceedances, run) {
  const publishedAt = new Date().toISOString();
  engineMetrics.forEach((metrics) => {
    const engine = ENGINES[metrics.esn];
    engine.egtMarginC = metrics.egtMarginC;
    engine.egtMarginHistory.push(metrics.egtMarginC);
    engine.egtMarginHistory = engine.egtMarginHistory.slice(-12);
    engine.vibrationN1 = metrics.vibrationN1;
    engine.vibrationN2 = metrics.vibrationN2;
    engine.oilPressureKpa = metrics.oilPressureKpa;
    engine.oilConsumptionQtHr = metrics.oilConsumptionQtHr;
    engine.altitudeFt = metrics.altitudeFt;
    engine.lastDataReceivedAt = publishedAt;
    SNAPSHOTS[metrics.esn] = [...(SNAPSHOTS[metrics.esn] || []), ...metrics.rows].slice(-20);
  });
  engineMetrics.forEach((metrics) => {
    EXCEEDANCES
      .filter((entry) => entry.esn === metrics.esn && entry.status === 'open')
      .forEach((entry) => {
        const replacement = exceedances.find((candidate) => candidate.esn === entry.esn && candidate.metric === entry.metric);
        if (!replacement) entry.status = 'closed';
      });
  });
  exceedances.forEach((entry) => {
    const existing = EXCEEDANCES.find((candidate) => candidate.esn === entry.esn
      && candidate.metric === entry.metric && candidate.status === 'open');
    if (existing) {
      existing.value = entry.value;
      existing.level = entry.level;
      existing.threshold = entry.threshold;
    } else {
      EXCEEDANCES.push(entry);
    }
  });
  lastSuccessfulPublishes[schema.code] = new Date(publishedAt).getTime();
  consecutiveFailures[schema.code] = 0;
  run.finishedAt = publishedAt;
  run.durationMs = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  run.stageReached = 'publish';
  run.status = 'succeeded';
  run.rowsOut = normalizedRows.length;
  return recordRun(run, { prepend: true });
}

function staleEngines(operatorCode, now) {
  return ENGINE_SEEDS[operatorCode]
    .map(([esn]) => ENGINES[esn])
    .filter((engine) => now - new Date(engine.lastDataReceivedAt).getTime() > STALE_AFTER_MS)
    .map((engine) => engine.esn);
}

async function sendAlert({ error, schema, run, stage, requestId, rowsIn, meta }) {
  const stale = staleEngines(schema.code, Date.now());
  const lastSuccessfulPublishAt = lastSuccessfulPublishes[schema.code]
    ? new Date(lastSuccessfulPublishes[schema.code]).toISOString()
    : null;
  const staleHours = stale.length ? Math.round((Date.now() - new Date(ENGINES[stale[0]].lastDataReceivedAt).getTime()) / 3600000) : 0;
  const alertData = {
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/a693dab5-${schema.code.toLowerCase()}-normalize`,
    culprit: 'app/services/verticals/a693dab5.js — normalizeSnapshots',
    errorType: error.name,
    errorValue: error.message,
    devinUserId: meta.devinUserId,
    devinEmail: meta.devinEmail,
    devinOrgId: meta.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Fleet Health Console — Engine Health Pipeline',
    slackMemberId: 'U0BDHHQUM24',
    tags: [
      { key: 'route', value: '/api/a693dab5/runs' },
      { key: 'service', value: SERVICE },
      { key: 'stage', value: stage },
      { key: 'operator', value: schema.code },
    ],
    extra: {
      requestId,
      runId: run.runId,
      operatorCode: schema.code,
      operatorName: schema.name,
      schemaVersion: schema.schemaVersion,
      stage,
      rowsIn,
      consecutiveFailures: consecutiveFailures[schema.code],
      staleEngines: stale,
      lastSuccessfulPublishAt,
      promptContext: `Operator ${schema.name}'s fleet of ${ENGINE_SEEDS[schema.code].length} engines has had no published health data for ~${staleHours}h; ${consecutiveFailures[schema.code] || 0} consecutive run(s) failed at the ${stage} stage. Missed data means a missed early warning.`,
    },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || 'a693dab5@1.0.0',
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
    promptAppendix: 'When you fix this, add regression tests covering every operator schema manifest (unit declarations and column mappings) so a future export-format change cannot pass CI untested, and record a browser video of the console showing the operator fleet leaving STALE.',
  };
  return createSessionAndAlert(alertData).catch((alertError) => {
    logger.error('Fleet health alert attempt failed', {
      service: SERVICE,
      operatorCode: schema.code,
      runId: run.runId,
      error: alertError.message,
    });
    return null;
  });
}

async function runPipeline(operatorCode, meta = {}) {
  const schema = getOperatorSchema(operatorCode);
  if (!schema) throw new Error(`Unknown operator ${operatorCode}`);
  const requestId = uuidv4();
  const startedAt = Date.now();
  let stage = 'ingest';
  let rowsIn = 0;
  const run = {
    runId: `run-${uuidv4().replace(/-/g, '').slice(0, 8)}`,
    operatorCode,
    operatorName: schema.name,
    trigger: meta.trigger || 'manual',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationMs: null,
    stageReached: 'ingest',
    status: 'failed',
    rowsIn: 0,
    rowsOut: 0,
    error: null,
  };
  logger.info('Starting fleet health pipeline', { service: SERVICE, operatorCode, runId: run.runId, stage });
  try {
    const ingested = ingestSnapshots(schema, Date.now());
    rowsIn = ingested.rowsIn;
    run.rowsIn = rowsIn;
    if (process.env.NODE_ENV !== 'test') {
      await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));
    }
    stage = 'normalize';
    run.stageReached = stage;
    const normalized = normalizeSnapshots(schema, ingested.rows);
    stage = 'compute_health';
    run.stageReached = stage;
    const engineMetrics = computeHealth(normalized);
    stage = 'evaluate_exceedances';
    run.stageReached = stage;
    const exceedances = evaluateExceedances(engineMetrics);
    stage = 'publish';
    run.stageReached = stage;
    const published = publish(schema, normalized, engineMetrics, exceedances, run);
    incrementMetric('a693dab5.pipeline.run', { operator: operatorCode, status: 'succeeded' });
    recordTiming('a693dab5.pipeline.duration', published.durationMs, { operator: operatorCode, status: 'succeeded' });
    return published;
  } catch (error) {
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - startedAt;
    run.stageReached = stage;
    run.rowsIn = rowsIn;
    run.error = { name: error.name, message: error.message, stage };
    recordRun(run, { prepend: true });
    consecutiveFailures[operatorCode] = (consecutiveFailures[operatorCode] || 0) + 1;
    incrementMetric('a693dab5.pipeline.run', { operator: operatorCode, status: 'failed' });
    recordTiming('a693dab5.pipeline.duration', run.durationMs, { operator: operatorCode, status: 'failed' });
    Sentry.captureException(error, {
      tags: {
        service: SERVICE,
        operator: operatorCode,
        stage,
        alert_path: 'instant',
      },
    });
    const shouldAlert = run.trigger === 'manual'
      || (consecutiveFailures[operatorCode] >= 3
        && (!lastAlerts[operatorCode] || Date.now() - lastAlerts[operatorCode] > ALERT_COOLDOWN_MS));
    if (shouldAlert) {
      const delivered = await sendAlert({ error, schema, run, stage, requestId, rowsIn, meta });
      if (delivered) lastAlerts[operatorCode] = Date.now();
    }
    return run;
  }
}

async function runAllOperators(meta = {}) {
  const rows = [];
  for (const operatorCode of Object.keys(OPERATOR_SCHEMAS)) {
    rows.push(await runPipeline(operatorCode, meta));
  }
  return rows;
}

function listRuns({ limit = 50, operatorCode } = {}) {
  const parsedLimit = Number(limit);
  const count = Math.min(Math.max(parsedLimit > 0 ? parsedLimit : 50, 1), MAX_RUNS_PAGE);
  return RUNS
    .filter((run) => !operatorCode || run.operatorCode === operatorCode)
    .slice()
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, count);
}

async function checkStaleness(now = Date.now()) {
  for (const schema of Object.values(OPERATOR_SCHEMAS)) {
    const lastPublishedAt = lastSuccessfulPublishes[schema.code];
    const stale = !lastPublishedAt || now - lastPublishedAt > STALE_AFTER_MS;
    const cooldownElapsed = !lastAlerts[schema.code]
      || now - lastAlerts[schema.code] > ALERT_COOLDOWN_MS;
    if (!stale || !cooldownElapsed) continue;

    const failedRun = listRuns({ operatorCode: schema.code, limit: MAX_RUNS_PAGE })
      .find((run) => run.status === 'failed');
    const error = failedRun && failedRun.error
      ? { name: failedRun.error.name, message: failedRun.error.message }
      : {
        name: 'StaleFeedError',
        message: `No engine-health rows published for ${schema.code} in ${Math.round((now - (lastPublishedAt || now)) / 3600000)}h`,
      };
    const run = failedRun || {
      runId: `stale-${schema.code.toLowerCase()}-${now}`,
      operatorCode: schema.code,
      rowsIn: 0,
    };
    const stage = failedRun && failedRun.error && failedRun.error.stage
      ? failedRun.error.stage
      : 'publish';
    const delivered = await sendAlert({
      error,
      schema,
      run,
      stage,
      requestId: uuidv4(),
      rowsIn: run.rowsIn || 0,
      meta: {},
    });
    if (delivered) lastAlerts[schema.code] = now;
  }
}

function deriveStatus(engine, openExceedances, now) {
  const stale = now - new Date(engine.lastDataReceivedAt).getTime() > STALE_AFTER_MS;
  const levels = { WARNING: 3, CAUTION: 2, ADVISORY: 1 };
  const worst = openExceedances
    .slice()
    .sort((a, b) => levels[b.level] - levels[a.level])[0];
  return {
    stale,
    status: stale ? 'STALE' : (worst ? worst.level : 'HEALTHY'),
  };
}

function getFleet(now = Date.now()) {
  const engines = Object.values(ENGINES).map((engine) => {
    const open = EXCEEDANCES.filter((entry) => entry.esn === engine.esn && entry.status === 'open');
    const derived = deriveStatus(engine, open, now);
    return {
      ...engine,
      operatorName: OPERATOR_SCHEMAS[engine.operatorCode].name,
      openExceedances: open.length,
      ...derived,
    };
  });
  const operators = Object.values(OPERATOR_SCHEMAS).map((schema) => {
    const operatorEngines = engines.filter((engine) => engine.operatorCode === schema.code);
    return {
      code: schema.code,
      name: schema.name,
      engineFamily: schema.engineFamily,
      engineCount: operatorEngines.length,
      staleCount: operatorEngines.filter((engine) => engine.stale).length,
      consecutiveFailures: consecutiveFailures[schema.code] || 0,
      lastPublishedAt: lastSuccessfulPublishes[schema.code]
        ? new Date(lastSuccessfulPublishes[schema.code]).toISOString()
        : null,
      schemaVersion: schema.schemaVersion,
      fileFormat: schema.fileFormat,
    };
  });
  const openLevels = { ADVISORY: 0, CAUTION: 0, WARNING: 0 };
  EXCEEDANCES.filter((entry) => entry.status === 'open').forEach((entry) => {
    openLevels[entry.level] += 1;
  });
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const openExceedances = EXCEEDANCES
    .filter((entry) => entry.status === 'open')
    .map((entry) => ({
      id: entry.id,
      esn: entry.esn,
      metric: entry.metric,
      level: entry.level,
      value: entry.value,
      threshold: entry.threshold,
      detectedAt: entry.detectedAt,
    }));
  return {
    operators,
    engines,
    openExceedances,
    staleAfterMs: STALE_AFTER_MS,
    generatedAt: new Date(now).toISOString(),
    summary: {
      engineCount: engines.length,
      staleCount: engines.filter((engine) => engine.stale).length,
      openExceedances: openLevels,
      failedRunsLast24h: failureTimestamps
        .filter((timestamp) => timestamp >= dayAgo && timestamp <= now).length,
      lastRunAt: RUNS.length ? listRuns({ limit: 1 })[0].startedAt : null,
    },
  };
}

function getEngine(esn) {
  const engine = ENGINES[esn];
  if (!engine) return null;
  const openExceedances = EXCEEDANCES.filter((entry) => entry.esn === esn && entry.status === 'open');
  const derived = deriveStatus(engine, openExceedances, Date.now());
  return {
    engine: {
      ...engine,
      operatorName: OPERATOR_SCHEMAS[engine.operatorCode].name,
      openExceedances: openExceedances.length,
      ...derived,
    },
    thresholds: THRESHOLDS[engine.family],
    snapshots: (SNAPSHOTS[esn] || []).slice().reverse(),
    exceedances: EXCEEDANCES
      .filter((entry) => entry.esn === esn)
      .slice()
      .sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open')
        || new Date(b.detectedAt) - new Date(a.detectedAt)),
  };
}

function startScheduler(intervalMs = Number(process.env.A693DAB5_RUN_INTERVAL_MS) || 180000) {
  stopScheduler();
  schedulerHandle = setInterval(() => {
    runAllOperators({ trigger: 'scheduled' })
      .then(() => checkStaleness())
      .catch((error) => {
        logger.error('Fleet health scheduler failed', { service: SERVICE, error: error.message });
      });
  }, intervalMs);
  schedulerHandle.unref();
  return schedulerHandle;
}

function stopScheduler() {
  if (schedulerHandle) clearInterval(schedulerHandle);
  schedulerHandle = null;
}

seedStore();

module.exports = {
  runPipeline,
  runAllOperators,
  listRuns,
  getFleet,
  getEngine,
  resetStore: seedStore,
  startScheduler,
  stopScheduler,
  checkStaleness,
  evaluateExceedances,
  getOperatorSchema,
  STAGES,
  ENGINES,
  RUNS,
  EXCEEDANCES,
};
