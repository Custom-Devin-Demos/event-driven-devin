const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { SCHEMA_REGISTRY, encodeFrame, decodeFrame } = require('./311c628f-frame-codec');

const SERVICE = '311c628f-api';
const RELEASE = process.env.SENTRY_RELEASE || 'plant-sensor-ingest@4.12.0';

const SITE = {
  id: 'FP',
  name: 'Texas Operations — Freeport',
  region: 'US Gulf Coast',
  timezone: 'America/Chicago',
  eventHub: 'evh-plant-sensor-readings-fp',
  eventHubNamespace: 'dow-ot-ingest-scus',
  stream: 'stream:sensor:fp:readings',
  consumerGroup: 'cg-historian-writer',
  consumerName: 'historian-writer-02',
  redisCluster: 'redis-ot-fp-prod (6 shards)',
  windowSeconds: 30,
  windowSize: 240,
};

const FIRMWARE_ROLLOUT = {
  vendor: 'Edge gateway platform',
  product: 'PLC edge gateway (OPC UA → Event Hubs bridge)',
  fromFirmware: '6.4.2',
  toFirmware: '7.0.1',
  changeTicket: 'CHG-221940',
  racksUpdated: 2,
  racksTotal: 5,
  releaseNotes: 'Frame format v7: signal address published as a structured object with a schema-registry reference; value and quality nested under val; timestamps moved to ISO-8601.',
};

const RACKS = [
  { rackId: 'PLC-LHC9-A', unit: 'LHC-9', unitName: 'LHC-9 Ethylene Cracker', controller: 'ControlLogix 5580', gatewayId: 'gw-fp-lhc9-01', firmware: '6.4.2', tags: 62 },
  { rackId: 'PLC-PE7-B', unit: 'PE-7', unitName: 'PE-7 Polyethylene Train', controller: 'ControlLogix 5580', gatewayId: 'gw-fp-pe7-01', firmware: '7.0.1', tags: 48 },
  { rackId: 'PLC-CA2-A', unit: 'CA-2', unitName: 'CA-2 Chlor-Alkali', controller: 'S7-1500', gatewayId: 'gw-fp-ca2-01', firmware: '7.0.1', tags: 54 },
  { rackId: 'PLC-UT4-C', unit: 'UT-4', unitName: 'UT-4 Utilities & Steam', controller: 'S7-1500', gatewayId: 'gw-fp-ut4-01', firmware: '6.4.2', tags: 40 },
  { rackId: 'PLC-PO1-A', unit: 'PO-1', unitName: 'PO-1 Propylene Oxide', controller: 'ControlLogix 5580', gatewayId: 'gw-fp-po1-01', firmware: '6.4.2', tags: 36 },
];

const TAG_CATALOG = [
  { unit: 'LHC-9', addr: 'TI-9104', description: 'Furnace F-104 coil outlet temperature', engineeringUnit: '°C', lo: 820, hi: 860, decimals: 1 },
  { unit: 'LHC-9', addr: 'PI-9122', description: 'Quench tower overhead pressure', engineeringUnit: 'kPa', lo: 118, hi: 132, decimals: 1 },
  { unit: 'LHC-9', addr: 'FI-9140', description: 'Ethane feed flow', engineeringUnit: 't/h', lo: 92, hi: 108, decimals: 2 },
  { unit: 'LHC-9', addr: 'AI-9161', description: 'Cracked gas ethylene purity', engineeringUnit: '% mol', lo: 99.85, hi: 99.96, decimals: 3 },
  { unit: 'PE-7', addr: 'TI-7104', description: 'Reactor R-704 bed temperature', engineeringUnit: '°C', lo: 84, hi: 92, decimals: 1 },
  { unit: 'PE-7', addr: 'PI-7110', description: 'Reactor loop pressure', engineeringUnit: 'bar', lo: 21.5, hi: 23.5, decimals: 2 },
  { unit: 'PE-7', addr: 'FI-7131', description: 'Hexene comonomer flow', engineeringUnit: 'kg/h', lo: 410, hi: 470, decimals: 0 },
  { unit: 'PE-7', addr: 'VI-7150', description: 'Extruder gearbox vibration', engineeringUnit: 'mm/s', lo: 1.8, hi: 3.2, decimals: 2 },
  { unit: 'CA-2', addr: 'EI-2210', description: 'Electrolyzer cell line current', engineeringUnit: 'kA', lo: 14.2, hi: 15.1, decimals: 2 },
  { unit: 'CA-2', addr: 'AI-2234', description: 'Brine feed chloride concentration', engineeringUnit: 'g/L', lo: 300, hi: 318, decimals: 1 },
  { unit: 'CA-2', addr: 'TI-2241', description: 'Caustic evaporator outlet temperature', engineeringUnit: '°C', lo: 138, hi: 146, decimals: 1 },
  { unit: 'CA-2', addr: 'PI-2260', description: 'Chlorine header pressure', engineeringUnit: 'kPa', lo: 95, hi: 110, decimals: 1 },
  { unit: 'UT-4', addr: 'PI-4101', description: 'HP steam header pressure', engineeringUnit: 'bar', lo: 98, hi: 104, decimals: 1 },
  { unit: 'UT-4', addr: 'FI-4118', description: 'Cooling tower makeup flow', engineeringUnit: 'm³/h', lo: 1850, hi: 2100, decimals: 0 },
  { unit: 'UT-4', addr: 'LI-4133', description: 'Demin water tank level', engineeringUnit: '%', lo: 58, hi: 74, decimals: 1 },
  { unit: 'PO-1', addr: 'TI-1107', description: 'HPPO reactor jacket temperature', engineeringUnit: '°C', lo: 44, hi: 52, decimals: 1 },
  { unit: 'PO-1', addr: 'AI-1120', description: 'Hydrogen peroxide feed concentration', engineeringUnit: '% wt', lo: 48, hi: 52, decimals: 2 },
  { unit: 'PO-1', addr: 'FI-1142', description: 'Propylene recycle flow', engineeringUnit: 't/h', lo: 36, hi: 42, decimals: 2 },
];

const TAG_REGISTRY = TAG_CATALOG.reduce((acc, tag) => {
  acc[`${SITE.id}/${tag.unit}/${tag.addr}`] = { ...tag, area: SITE.id };
  return acc;
}, {});

const DOWNSTREAM_DEFINITIONS = {
  historian: { key: 'historian', label: 'Process historian', system: 'AVEVA PI — FP collective', detail: 'Long-term tag archive for the site' },
  reliability: { key: 'reliability', label: 'Reliability analytics', system: 'Predictive maintenance models', detail: 'Vibration and temperature trend scoring' },
  environmental: { key: 'environmental', label: 'Environmental monitoring', system: 'Flare & emissions reporting', detail: 'Regulatory rollups for air permits' },
  hmi: { key: 'hmi', label: 'Control room dashboards', system: 'Operations HMI overview boards', detail: 'Unit KPIs for shift supervisors' },
};

const SEEDED_WINDOWS = 6;

const STREAM = {};
const WINDOWS = [];
const PENDING = [];
const DOWNSTREAM = {};
let WINDOW_COUNTER = 0;
let GENERATION = 0;

function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function round(value, decimals) {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function secondsAgo(seconds, from = Date.now()) {
  return from - seconds * 1000;
}

function rackFor(unit) {
  return RACKS.find((rack) => rack.unit === unit);
}

function streamEntryId(windowNo, index, baseMs) {
  return `${baseMs + index * 125}-${windowNo % 7}`;
}

function buildWindow(windowNo, receivedAt, firmware) {
  const random = createRandom(311628 + windowNo * 7919);
  const entries = [];
  const baseMs = secondsAgo(SITE.windowSeconds, receivedAt);
  for (let i = 0; i < SITE.windowSize; i += 1) {
    const tag = TAG_CATALOG[i % TAG_CATALOG.length];
    const rack = firmware ? { ...rackFor(tag.unit), firmware } : rackFor(tag.unit);
    const sample = {
      seq: windowNo * SITE.windowSize + i,
      value: round(tag.lo + (tag.hi - tag.lo) * random(), tag.decimals),
      qualityCode: random() < 0.985 ? 192 : 64,
      observedAt: baseMs + i * 125,
    };
    entries.push({
      entryId: streamEntryId(windowNo, i, baseMs),
      partition: tag.unit === 'LHC-9' || tag.unit === 'PE-7' ? 0 : tag.unit === 'CA-2' ? 1 : 2,
      frame: encodeFrame(rack, { area: SITE.id, unit: tag.unit, addr: tag.addr }, sample),
    });
  }
  return {
    windowNo,
    windowId: `W-${String(windowNo).padStart(5, '0')}`,
    stream: SITE.stream,
    consumerGroup: SITE.consumerGroup,
    receivedAt: new Date(receivedAt).toISOString(),
    entries,
  };
}

function decodeWindow(entries) {
  return entries.map((entry) => ({ entryId: entry.entryId, partition: entry.partition, reading: decodeFrame(entry.frame) }));
}

function enrichReadings(decoded) {
  return decoded.map(({ entryId, partition, reading }) => {
    const meta = TAG_REGISTRY[reading.tagPath];
    return {
      entryId,
      partition,
      tagPath: reading.tagPath,
      unit: meta.unit,
      description: meta.description,
      value: reading.value,
      engineeringUnit: meta.engineeringUnit,
      quality: reading.quality,
      observedAt: new Date(reading.observedAt).toISOString(),
      firmware: reading.firmware,
      gatewayId: reading.gatewayId,
    };
  });
}

function summarizeFirmware(entries) {
  return entries.reduce((acc, entry) => {
    acc[entry.frame.fw] = (acc[entry.frame.fw] || 0) + 1;
    return acc;
  }, {});
}

function unitRollup(readings) {
  const byUnit = {};
  readings.forEach((reading) => {
    if (!byUnit[reading.unit]) byUnit[reading.unit] = { unit: reading.unit, readings: 0, good: 0, uncertain: 0 };
    byUnit[reading.unit].readings += 1;
    if (reading.quality === 'good') byUnit[reading.unit].good += 1;
    else byUnit[reading.unit].uncertain += 1;
  });
  return Object.values(byUnit);
}

function writeDownstream(readings, writtenAt) {
  Object.values(DOWNSTREAM).forEach((sink) => {
    sink.lastWriteAt = writtenAt;
    sink.rowsWritten += readings.length;
    sink.status = 'current';
    sink.lagWindows = 0;
  });
}

function processWindow(window, run) {
  run.stage = 'decode';
  const decoded = decodeWindow(window.entries);
  run.stage = 'enrich';
  const readings = enrichReadings(decoded);
  run.stage = 'write';
  writeDownstream(readings, run.completedAt || new Date().toISOString());
  return readings;
}

function ackWindow(window, readings, run) {
  const completedAt = new Date().toISOString();
  STREAM.lastDeliveredId = window.entries[window.entries.length - 1].entryId;
  STREAM.pendingEntries = Math.max(0, STREAM.pendingEntries - window.entries.length) + 96;
  STREAM.lastAckAt = completedAt;
  STREAM.lagMs = 380 + Math.round(Math.random() * 90);
  STREAM.entriesProcessed += readings.length;
  STREAM.windowsProcessed += 1;
  const pendingIndex = PENDING.findIndex((p) => p.windowId === window.windowId);
  if (pendingIndex >= 0) PENDING.splice(pendingIndex, 1);
  if (!PENDING.length) {
    STREAM.status = 'healthy';
    STREAM.stalledAt = null;
    STREAM.blockingEntryId = null;
    Object.values(DOWNSTREAM).forEach((sink) => {
      sink.status = 'current';
      sink.lagWindows = 0;
    });
  } else {
    Object.values(DOWNSTREAM).forEach((sink) => {
      sink.status = 'stale';
      sink.lagWindows = PENDING.length;
    });
  }
  WINDOWS.unshift({
    windowId: window.windowId,
    windowNo: window.windowNo,
    receivedAt: window.receivedAt,
    completedAt,
    status: 'acked',
    entries: window.entries.length,
    firmware: summarizeFirmware(window.entries),
    units: unitRollup(readings),
    requestId: run.requestId,
    durationMs: run.durationMs,
  });
  if (WINDOWS.length > 40) WINDOWS.length = 40;
}

function blockingEntry(window, run) {
  const index = run.failedIndex >= 0 ? run.failedIndex : 0;
  return window.entries[index];
}

function markStalled(window, run, error, failedAt) {
  const entry = blockingEntry(window, run);
  STREAM.status = 'stalled';
  STREAM.stalledAt = STREAM.stalledAt || failedAt;
  STREAM.blockingEntryId = entry.entryId;
  STREAM.lastError = `${error.name}: ${error.message}`;
  STREAM.lastErrorAt = failedAt;
  Object.values(DOWNSTREAM).forEach((sink) => {
    sink.status = 'stale';
    sink.lagWindows += 1;
  });
  if (!PENDING.some((p) => p.windowId === window.windowId)) {
    STREAM.pendingEntries += window.entries.length;
    PENDING.unshift({
      windowId: window.windowId,
      windowNo: window.windowNo,
      receivedAt: window.receivedAt,
      failedAt,
      deliveries: 1,
      entries: window.entries.length,
      firmware: summarizeFirmware(window.entries),
      blockingEntryId: entry.entryId,
      blockingFrame: entry.frame,
      stage: run.stage,
      error: `${error.name}: ${error.message}`,
      requestId: run.requestId,
    });
  } else {
    const existing = PENDING.find((p) => p.windowId === window.windowId);
    existing.deliveries += 1;
    existing.failedAt = failedAt;
    existing.error = `${error.name}: ${error.message}`;
  }
  WINDOWS.unshift({
    windowId: window.windowId,
    windowNo: window.windowNo,
    receivedAt: window.receivedAt,
    completedAt: failedAt,
    status: 'failed',
    entries: window.entries.length,
    firmware: summarizeFirmware(window.entries),
    units: [],
    requestId: run.requestId,
    durationMs: run.durationMs,
    error: `${error.name}: ${error.message}`,
    stage: run.stage,
  });
  if (WINDOWS.length > 40) WINDOWS.length = 40;
}

function liveBacklog() {
  if (STREAM.status !== 'stalled' || !STREAM.stalledAt) {
    return { pendingEntries: STREAM.pendingEntries, oldestPendingMs: STREAM.lagMs, lagMs: STREAM.lagMs };
  }
  const stalledForMs = Date.now() - Date.parse(STREAM.stalledAt);
  const inflowPerSecond = SITE.windowSize / SITE.windowSeconds;
  const accrued = Math.round((stalledForMs / 1000) * inflowPerSecond);
  return {
    pendingEntries: STREAM.pendingEntries + accrued,
    oldestPendingMs: stalledForMs + SITE.windowSeconds * 1000,
    lagMs: stalledForMs + STREAM.lagMs,
  };
}

function currentSummary() {
  const backlog = liveBacklog();
  return {
    status: STREAM.status,
    stream: SITE.stream,
    consumerGroup: SITE.consumerGroup,
    consumerName: SITE.consumerName,
    lastDeliveredId: STREAM.lastDeliveredId,
    lastAckAt: STREAM.lastAckAt,
    pendingEntries: backlog.pendingEntries,
    oldestPendingMs: backlog.oldestPendingMs,
    lagMs: backlog.lagMs,
    entriesProcessed: STREAM.entriesProcessed,
    windowsProcessed: STREAM.windowsProcessed,
    throughputPerSecond: STREAM.status === 'stalled' ? 0 : SITE.windowSize / SITE.windowSeconds,
    stalledAt: STREAM.stalledAt,
    blockingEntryId: STREAM.blockingEntryId,
    lastError: STREAM.status === 'stalled' ? STREAM.lastError : null,
    pendingWindows: PENDING.length,
    racksReporting: RACKS.length,
    tagsConfigured: RACKS.reduce((sum, rack) => sum + rack.tags, 0),
  };
}

function alertData(error, window, run, meta) {
  const firmware = summarizeFirmware(window.entries);
  const entry = blockingEntry(window, run);
  const affectedRacks = RACKS.filter((rack) => rack.firmware === FIRMWARE_ROLLOUT.toFirmware).map((rack) => rack.rackId);
  const backlog = liveBacklog();
  return {
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
    culprit: 'app/services/verticals/311c628f.js — enrichReadings',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: meta.devinUserId,
    devinEmail: meta.devinEmail,
    devinOrgId: meta.devinOrgId,
    service: SERVICE,
    verticalLabel: 'Dow — Plant Sensor Event Ingest (PLC → Event Hubs → Redis Streams → historian)',
    tags: [
      { key: 'route', value: '/api/311c628f/consumer/run' },
      { key: 'service', value: SERVICE },
      { key: 'component', value: 'sensor-stream-consumer' },
      { key: 'site', value: SITE.id },
      { key: 'stream', value: SITE.stream },
      { key: 'consumer_group', value: SITE.consumerGroup },
      { key: 'window', value: window.windowId },
      { key: 'stage', value: run.stage },
      { key: 'gateway_firmware', value: FIRMWARE_ROLLOUT.toFirmware },
      { key: 'change_ticket', value: FIRMWARE_ROLLOUT.changeTicket },
    ],
    extra: {
      requestId: run.requestId,
      windowId: window.windowId,
      stream: SITE.stream,
      consumerGroup: SITE.consumerGroup,
      consumerName: SITE.consumerName,
      entryCount: window.entries.length,
      firmwareInWindow: firmware,
      blockingEntryId: entry.entryId,
      blockingFrame: entry.frame,
      pendingEntries: backlog.pendingEntries,
      oldestPendingMs: backlog.oldestPendingMs,
      affectedRacks,
      firmwareRollout: FIRMWARE_ROLLOUT,
      schemaRegistry: Object.keys(SCHEMA_REGISTRY),
      downstream: Object.values(DOWNSTREAM).map((sink) => ({ key: sink.key, status: sink.status, lagWindows: sink.lagWindows })),
      retryEndpoint: 'POST /api/311c628f/consumer/retry',
    },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: RELEASE,
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: `Datadog monitor: sensor.stream.consumer.lag_ms > 60000 for 5m (${SITE.stream} / ${SITE.consumerGroup})`,
    promptAppendix: [
      '## Incident context',
      `- The sensor-event consumer \`${SITE.consumerName}\` in group \`${SITE.consumerGroup}\` is falling behind on Redis Stream \`${SITE.stream}\` at ${SITE.name}. Plant readings arrive from PLC edge gateways via Event Hubs \`${SITE.eventHub}\` and are bridged onto the stream in ${SITE.windowSeconds}s windows of ${SITE.windowSize} entries.`,
      `- Window ${window.windowId} fails every delivery at stage \`${run.stage}\` and is never acknowledged, so the pending-entries list keeps growing (${backlog.pendingEntries} pending, oldest ~${Math.round(backlog.oldestPendingMs / 1000)}s). The blocking entry is \`${entry.entryId}\`.`,
      `- The window mixes gateway firmware (${Object.entries(firmware).map(([k, v]) => `${k}: ${v}`).join(', ')}). ${FIRMWARE_ROLLOUT.changeTicket} rolled gateway firmware ${FIRMWARE_ROLLOUT.fromFirmware} → ${FIRMWARE_ROLLOUT.toFirmware} to ${FIRMWARE_ROLLOUT.racksUpdated} of ${FIRMWARE_ROLLOUT.racksTotal} PLC racks (${affectedRacks.join(', ')}). Release notes: ${FIRMWARE_ROLLOUT.releaseNotes}`,
      '- The process historian, reliability analytics, environmental monitoring and control-room dashboards have received no readings since the stall.',
      '- Blocking entry frame (new format):',
      '```json',
      JSON.stringify(entry.frame, null, 2),
      '```',
      '',
      '## Remediation expectations',
      '- Read the service logs, the codec in `app/services/verticals/311c628f-frame-codec.js` and the consumer pipeline in `app/services/verticals/311c628f.js`, and tie the stall to the gateway firmware rollout.',
      '- Fix the parser/decoder path so frames from BOTH firmware lines (6.x flat and 7.x structured) decode into the same enriched reading shape before the historian write. Do not drop or skip readings from either format.',
      '- Add a dead-letter path: a single undecodable entry must be quarantined (with its entry id, frame and error) and the rest of the window acknowledged, instead of one bad message blocking the whole stream.',
      '- Add a unit test covering one frame of each firmware line plus one undecodable frame, asserting the identical reading shape and the dead-letter behaviour.',
      '- Re-deliver the pending window via `POST /api/311c628f/consumer/retry` once the fix is in place and confirm the pending count drains.',
      '- Post a plain-language root cause (what broke, why, what changed) in the PR description and in the Slack thread — a human approves every change; do not merge.',
    ].join('\n'),
  };
}

async function consumeWindow(window, meta, trigger) {
  const run = { requestId: uuidv4(), stage: 'claim', failedIndex: -1 };
  const startedAt = Date.now();
  const generation = GENERATION;

  logger.info('Sensor stream window claimed', {
    requestId: run.requestId,
    windowId: window.windowId,
    stream: window.stream,
    consumerGroup: window.consumerGroup,
    entries: window.entries.length,
    firmware: summarizeFirmware(window.entries),
    trigger,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));
    if (generation !== GENERATION) {
      logger.warn('Sensor stream window dropped — consumer group was reset mid-delivery', { requestId: run.requestId, windowId: window.windowId, service: SERVICE });
      return { success: false, cancelled: true, windowId: window.windowId, summary: currentSummary() };
    }
    const readings = processWindow(window, run);
    run.stage = 'ack';
    run.durationMs = Date.now() - startedAt;
    ackWindow(window, readings, run);

    recordTiming('sensor.stream.window.duration', run.durationMs, [`site:${SITE.id}`, `group:${SITE.consumerGroup}`]);
    incrementMetric('sensor.stream.window.acked', [`site:${SITE.id}`, `group:${SITE.consumerGroup}`]);
    recordMetric('sensor.stream.consumer.lag_ms', STREAM.lagMs, [`site:${SITE.id}`, `group:${SITE.consumerGroup}`]);
    recordMetric('sensor.stream.pending_entries', STREAM.pendingEntries, [`site:${SITE.id}`, `group:${SITE.consumerGroup}`]);

    logger.info('Sensor stream window acknowledged', {
      requestId: run.requestId,
      windowId: window.windowId,
      readings: readings.length,
      durationMs: run.durationMs,
      lagMs: STREAM.lagMs,
      service: SERVICE,
    });

    return {
      success: true,
      requestId: run.requestId,
      windowId: window.windowId,
      readings: readings.length,
      units: unitRollup(readings),
      summary: currentSummary(),
    };
  } catch (error) {
    run.durationMs = Date.now() - startedAt;
    const failedAt = new Date().toISOString();
    run.failedIndex = window.entries.findIndex((entry) => entry.frame.schemaRef);
    markStalled(window, run, error, failedAt);
    const backlog = liveBacklog();

    incrementMetric('sensor.stream.window.failed', [`site:${SITE.id}`, `group:${SITE.consumerGroup}`, `stage:${run.stage}`]);
    recordMetric('sensor.stream.consumer.lag_ms', backlog.lagMs, [`site:${SITE.id}`, `group:${SITE.consumerGroup}`]);
    recordMetric('sensor.stream.pending_entries', backlog.pendingEntries, [`site:${SITE.id}`, `group:${SITE.consumerGroup}`]);
    recordTiming('sensor.stream.window.duration', run.durationMs, [`site:${SITE.id}`, `group:${SITE.consumerGroup}`, 'outcome:failed']);

    logger.error('Sensor stream window failed — entry left pending, consumer stalled', {
      requestId: run.requestId,
      windowId: window.windowId,
      stage: run.stage,
      blockingEntryId: STREAM.blockingEntryId,
      pendingEntries: backlog.pendingEntries,
      oldestPendingMs: backlog.oldestPendingMs,
      firmware: summarizeFirmware(window.entries),
      error: error.message,
      errorType: error.name,
      stack: error.stack,
      trigger,
      service: SERVICE,
    });

    Sentry.withScope((scope) => {
      scope.setTag('route', trigger === 'retry' ? '/api/311c628f/consumer/retry' : '/api/311c628f/consumer/run');
      scope.setTag('service', SERVICE);
      scope.setTag('alert_path', 'instant');
      scope.setTag('component', 'sensor-stream-consumer');
      scope.setTag('site', SITE.id);
      scope.setTag('stream', SITE.stream);
      scope.setTag('consumer_group', SITE.consumerGroup);
      scope.setTag('window', window.windowId);
      scope.setTag('stage', run.stage);
      scope.setContext('window', { windowId: window.windowId, entries: window.entries.length, firmware: summarizeFirmware(window.entries), blockingEntryId: STREAM.blockingEntryId });
      scope.setContext('firmwareRollout', FIRMWARE_ROLLOUT);
      Sentry.captureException(error);
    });

    if (trigger !== 'retry') {
      createSessionAndAlert(alertData(error, window, run, meta)).catch((err) => {
        logger.error('Failed to trigger Devin session', { error: err.message, service: SERVICE });
      });
    }
    throw error;
  }
}

function redeliverHead(meta, trigger) {
  const head = PENDING[PENDING.length - 1];
  const window = buildWindow(head.windowNo, Date.parse(head.receivedAt));
  logger.info('Re-delivering pending sensor window', { windowId: window.windowId, deliveries: head.deliveries + 1, trigger, service: SERVICE });
  return consumeWindow(window, meta, trigger);
}

async function runNextWindow(meta = {}) {
  if (PENDING.length) {
    return redeliverHead(meta, meta.trigger || 'manual');
  }
  WINDOW_COUNTER += 1;
  const window = buildWindow(WINDOW_COUNTER, Date.now());
  return consumeWindow(window, meta, meta.trigger || 'manual');
}

async function retryPending(meta = {}) {
  if (!PENDING.length) {
    return { success: true, retried: 0, summary: currentSummary() };
  }
  const result = await redeliverHead(meta, 'retry');
  return { ...result, retried: result.cancelled ? 0 : 1 };
}

function seedStore() {
  GENERATION += 1;
  WINDOWS.length = 0;
  PENDING.length = 0;
  WINDOW_COUNTER = 0;
  Object.keys(DOWNSTREAM).forEach((key) => delete DOWNSTREAM[key]);
  Object.keys(STREAM).forEach((key) => delete STREAM[key]);

  Object.values(DOWNSTREAM_DEFINITIONS).forEach((def) => {
    DOWNSTREAM[def.key] = { ...def, status: 'current', lagWindows: 0, rowsWritten: 0, lastWriteAt: null };
  });

  Object.assign(STREAM, {
    status: 'healthy',
    lastDeliveredId: null,
    lastAckAt: null,
    pendingEntries: 96,
    lagMs: 412,
    entriesProcessed: 1_482_960,
    windowsProcessed: 6179,
    stalledAt: null,
    blockingEntryId: null,
    lastError: null,
    lastErrorAt: null,
  });

  const now = Date.now();
  const random = createRandom(628);
  for (let i = SEEDED_WINDOWS; i >= 1; i -= 1) {
    const receivedAt = secondsAgo(i * SITE.windowSeconds + 4, now);
    const windowNo = 6179 - SEEDED_WINDOWS + (SEEDED_WINDOWS - i) + 1;
    const window = buildWindow(windowNo, receivedAt, FIRMWARE_ROLLOUT.fromFirmware);
    const readings = enrichReadings(decodeWindow(window.entries));
    const completedAt = new Date(receivedAt + 180 + Math.round(random() * 90)).toISOString();
    Object.values(DOWNSTREAM).forEach((sink) => {
      sink.rowsWritten += window.entries.length;
      sink.lastWriteAt = completedAt;
    });
    WINDOWS.unshift({
      windowId: window.windowId,
      windowNo,
      receivedAt: window.receivedAt,
      completedAt,
      status: 'acked',
      entries: window.entries.length,
      firmware: summarizeFirmware(window.entries),
      units: unitRollup(readings),
      requestId: uuidv4(),
      durationMs: 180 + Math.round(random() * 90),
    });
    STREAM.lastDeliveredId = window.entries[window.entries.length - 1].entryId;
    STREAM.lastAckAt = completedAt;
  }
  WINDOW_COUNTER = 6179;
}

function getOverview() {
  if (STREAM.status === 'stalled') {
    const backlog = liveBacklog();
    recordMetric('sensor.stream.consumer.lag_ms', backlog.lagMs, [`site:${SITE.id}`, `group:${SITE.consumerGroup}`]);
    recordMetric('sensor.stream.pending_entries', backlog.pendingEntries, [`site:${SITE.id}`, `group:${SITE.consumerGroup}`]);
  }
  return {
    site: SITE,
    summary: currentSummary(),
    racks: RACKS,
    firmwareRollout: FIRMWARE_ROLLOUT,
    downstream: Object.values(DOWNSTREAM),
    recentWindows: WINDOWS.slice(0, 12),
    pending: PENDING,
    tags: TAG_CATALOG,
  };
}

function listWindows() {
  return WINDOWS;
}

function listPending() {
  return PENDING;
}

function resetConsumer() {
  const cleared = { windows: WINDOWS.length, pending: PENDING.length, wasStalled: STREAM.status === 'stalled' };
  seedStore();
  logger.info('Sensor stream consumer demo state reset', { ...cleared, service: SERVICE });
  incrementMetric('sensor.stream.reset', [`site:${SITE.id}`, `group:${SITE.consumerGroup}`]);
  return { success: true, cleared, summary: currentSummary() };
}

seedStore();

module.exports = {
  runNextWindow,
  retryPending,
  resetConsumer,
  getOverview,
  listWindows,
  listPending,
  SITE,
  RACKS,
  TAG_CATALOG,
  FIRMWARE_ROLLOUT,
  DOWNSTREAM_DEFINITIONS,
};
