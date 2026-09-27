const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  MESSAGE_SCHEMAS,
  schemaFor,
  readField,
  toIsoTimestamp,
} = require('./0a6f5e56-message-schemas');

const SERVICE = '0a6f5e56-api';
const RELEASE = process.env.SENTRY_RELEASE || 'obc-event-ingest@5.8.1';
const SLACK_MEMBER_ID = 'U0BDHHQUM24';

const DISTRICT = {
  id: '3120',
  name: 'Northwest Houston Hauling',
  marketArea: 'Texas — Gulf Coast',
  timezone: 'America/Chicago',
  gateway: 'Peregrine Fleet Gateway',
  topic: 'obc.events.district-3120',
  cadenceMinutes: 15,
  unitsTotal: 118,
};

const VENDOR_ROLLOUT = {
  vendor: 'Peregrine Telematics',
  product: 'OBC-7 onboard computer',
  fromFirmware: '3.2.11',
  toFirmware: '4.0.2',
  changeTicket: 'CHG-48817',
  unitsUpdated: 31,
  unitsTotal: DISTRICT.unitsTotal,
  releaseNotes: 'Event envelope restructured (nested event/asset/route/service objects), timestamps moved to ISO-8601, event codes renamed.',
};

const SINK_ROUTING = {
  ROUTE_STARTED: ['dispatch', 'reporting'],
  CONTAINER_SERVICED: ['dispatch', 'billing', 'reporting'],
  NOT_OUT: ['dispatch', 'billing', 'reporting'],
  BLOCKED: ['dispatch', 'reporting'],
  CONTAMINATED: ['dispatch', 'billing', 'reporting'],
  MILEAGE: ['reporting'],
};

const SINK_DEFINITIONS = {
  dispatch: { key: 'dispatch', label: 'Dispatch', system: 'RouteBoard — live route progress', table: 'dispatch.route_stop_events' },
  billing: { key: 'billing', label: 'Billing', system: 'Service confirmations → invoicing', table: 'billing.service_confirmations' },
  reporting: { key: 'reporting', label: 'Reporting', system: 'Operations data warehouse', table: 'rpt.fleet_events_daily' },
};

const ROUTE_CATALOG = [
  { routeId: 'RES-M-4412', type: 'Residential — Automated side load', area: 'Cypress North', unitId: '213486', stopsTotal: 1240 },
  { routeId: 'RES-M-4418', type: 'Residential — Automated side load', area: 'Jersey Village', unitId: '213502', stopsTotal: 1185 },
  { routeId: 'RES-M-4423', type: 'Residential — Rear load', area: 'Spring Branch West', unitId: '208934', stopsTotal: 960 },
  { routeId: 'REC-M-6120', type: 'Recycling — Automated side load', area: 'Copperfield', unitId: '214117', stopsTotal: 1102 },
  { routeId: 'REC-M-6124', type: 'Recycling — Automated side load', area: 'Fairfield', unitId: '215260', stopsTotal: 1044 },
  { routeId: 'COM-FL-2207', type: 'Commercial — Front load', area: 'US-290 corridor', unitId: '211078', stopsTotal: 142 },
  { routeId: 'COM-FL-2211', type: 'Commercial — Front load', area: 'Willowbrook', unitId: '209845', stopsTotal: 131 },
  { routeId: 'ROLL-0931', type: 'Industrial — Roll-off', area: 'Northwest Freeway', unitId: '213590', stopsTotal: 18 },
  { routeId: 'RES-M-4431', type: 'Residential — Automated side load', area: 'Bear Creek', unitId: '216004', stopsTotal: 1210 },
  { routeId: 'YRD-M-7302', type: 'Yard waste — Rear load', area: 'Cypress North', unitId: '212751', stopsTotal: 640 },
  { routeId: 'RES-M-4436', type: 'Residential — Automated side load', area: 'Tomball Parkway', unitId: '210362', stopsTotal: 1176 },
  { routeId: 'COM-FL-2219', type: 'Commercial — Front load', area: 'Beltway 8 North', unitId: '214980', stopsTotal: 156 },
];

const FLEET_CATALOG = [
  { unitId: '213486', chassis: 'Autocar ACX64', body: 'Heil DuraPack Python ASL', fuel: 'CNG', firmware: '4.0.2' },
  { unitId: '213502', chassis: 'Autocar ACX64', body: 'Heil DuraPack Python ASL', fuel: 'CNG', firmware: '3.2.11' },
  { unitId: '208934', chassis: 'Mack LR', body: 'McNeilus Rear Loader', fuel: 'CNG', firmware: '3.2.11' },
  { unitId: '214117', chassis: 'Autocar ACX64', body: 'Labrie Automizer ASL', fuel: 'CNG', firmware: '4.0.2' },
  { unitId: '215260', chassis: 'Peterbilt 520', body: 'Labrie Automizer ASL', fuel: 'CNG', firmware: '3.2.11' },
  { unitId: '211078', chassis: 'Mack LR', body: 'Heil Half/Pack Front Loader', fuel: 'CNG', firmware: '3.2.11' },
  { unitId: '209845', chassis: 'Autocar ACX64', body: 'McNeilus Atlantic Front Loader', fuel: 'CNG', firmware: '4.0.2' },
  { unitId: '213590', chassis: 'Mack Granite', body: 'Galbreath Roll-off hoist', fuel: 'Diesel', firmware: '3.2.11' },
  { unitId: '216004', chassis: 'Mack LR Electric', body: 'Heil DuraPack Python ASL', fuel: 'BEV', firmware: '4.0.2' },
  { unitId: '212751', chassis: 'Peterbilt 520', body: 'McNeilus Rear Loader', fuel: 'CNG', firmware: '3.2.11' },
  { unitId: '210362', chassis: 'Autocar ACX64', body: 'Heil DuraPack Python ASL', fuel: 'CNG', firmware: '3.2.11' },
  { unitId: '214980', chassis: 'Mack LR', body: 'Heil Half/Pack Front Loader', fuel: 'CNG', firmware: '4.0.2' },
];

const SEEDED_BATCHES = 5;
const BATCH_SIZE = 46;

let RUNS = [];
let PARKED = [];
let ROUTES = [];
let FLEET = [];
let SINKS = {};
let ingestState = {};
let nextBatchNo = 1;
let rolloutStartedAt = null;

function createRandom(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function minutesAgo(minutes, from = Date.now()) {
  return new Date(from - minutes * 60000);
}

function firmwareForBatch(unit, batchNo) {
  if (batchNo <= SEEDED_BATCHES) return VENDOR_ROLLOUT.fromFirmware;
  return unit.firmware;
}

function schemaForFirmware(firmware) {
  return firmware.startsWith('4.') ? 'obc/4.0' : 'obc/3.2';
}

function encodeMessage(schema, unit, seq, event, occurredAt) {
  const epochS = Math.floor(occurredAt.getTime() / 1000);
  if (schema === 'obc/3.2') {
    const body = { msg_type: event.code32, route_id: event.routeId, ts: epochS, lat: event.lat, lon: event.lon };
    if (event.containerId) body.container_id = event.containerId;
    if (event.outcome) body.svc_result = event.outcome;
    if (event.odometerMi !== undefined) body.odo_mi = event.odometerMi;
    return { header: { schema, unit: unit.unitId, seq, sent: epochS }, body };
  }
  const body = {
    event: { code: event.code40, occurredAt: occurredAt.toISOString() },
    asset: { unit: unit.unitId, firmware: unit.firmware },
    route: { id: event.routeId },
    position: { lat: event.lat, lon: event.lon },
  };
  if (event.containerId) body.service = { containerId: event.containerId, outcome: event.outcome === 'COMPLETE' ? 'COMPLETED' : event.outcome };
  if (event.odometerMi !== undefined) body.odometer = { miles: event.odometerMi };
  return { header: { schema, unit: unit.unitId, seq, sent: occurredAt.toISOString() }, body };
}

function buildBatch(batchNo, receivedAt) {
  const random = createRandom(batchNo * 7919 + 17);
  const messages = [];
  const windowStart = receivedAt.getTime() - DISTRICT.cadenceMinutes * 60000;
  const routeCount = ROUTE_CATALOG.length;
  for (let i = 0; i < BATCH_SIZE; i += 1) {
    const route = ROUTE_CATALOG[Math.floor(random() * routeCount)];
    const unit = FLEET.find((u) => u.unitId === route.unitId);
    const firmware = firmwareForBatch(unit, batchNo);
    const schema = schemaForFirmware(firmware);
    const occurredAt = new Date(windowStart + random() * DISTRICT.cadenceMinutes * 60000);
    const roll = random();
    const lat = 29.86 + random() * 0.18;
    const lon = -95.72 + random() * 0.22;
    const event = { routeId: route.routeId, lat: Number(lat.toFixed(5)), lon: Number(lon.toFixed(5)) };
    if (roll < 0.06) {
      event.code32 = 'ROUTE_START';
      event.code40 = 'ROUTE_STARTED';
    } else if (roll < 0.16) {
      event.code32 = 'ODOMETER';
      event.code40 = 'ODOMETER_SNAPSHOT';
      event.odometerMi = Number((38000 + random() * 42000).toFixed(1));
    } else if (roll < 0.25) {
      event.code32 = 'SVC_EXCEPTION';
      event.code40 = 'SERVICE_EXCEPTION';
      event.containerId = `C-${String(2000000 + Math.floor(random() * 899999))}`;
      event.outcome = random() < 0.8 ? 'NOT_OUT' : 'BLOCKED';
    } else {
      event.code32 = 'SVC_COMPLETE';
      event.code40 = 'SERVICE_COMPLETED';
      event.containerId = `C-${String(2000000 + Math.floor(random() * 899999))}`;
      event.outcome = 'COMPLETE';
    }
    const seq = 88000 + batchNo * 500 + i;
    messages.push(encodeMessage(schema, { ...unit, firmware }, seq, event, occurredAt));
  }
  messages.sort((a, b) => a.header.seq - b.header.seq);
  return {
    batchNo,
    batchId: `BATCH-3120-${String(batchNo).padStart(6, '0')}`,
    receivedAt: receivedAt.toISOString(),
    source: DISTRICT.gateway,
    topic: DISTRICT.topic,
    messages,
  };
}

function summarizeSchemas(messages) {
  return messages.reduce((acc, message) => {
    const schema = message.header.schema;
    acc[schema] = (acc[schema] || 0) + 1;
    return acc;
  }, {});
}

function exceptionType(schema, outcome) {
  const mapped = schema.outcomes[outcome];
  if (!mapped) throw new Error(`Unknown service outcome "${outcome}" for ${schema.vendor} ${schema.firmware}`);
  return mapped;
}

function normalizeMessage(raw) {
  const schema = schemaFor(raw.header);
  const body = raw.body;
  const code = readField(body, schema.fields.type);
  const eventType = schema.eventCodes[code];
  if (!eventType) throw new Error(`Unknown event code "${code}" in ${raw.header.schema} message seq ${raw.header.seq}`);

  const outcome = readField(body, schema.fields.outcome);
  const normalized = {
    type: eventType === 'SERVICE_EXCEPTION' ? exceptionType(schema, outcome) : eventType,
    unitId: raw.header.unit,
    seq: raw.header.seq,
    schema: raw.header.schema,
    routeId: readField(body, schema.fields.route),
    containerId: readField(body, schema.fields.container) || null,
    odometerMi: readField(body, schema.fields.odometer),
    occurredAt: toIsoTimestamp(readField(body, schema.fields.occurredAt), schema.timestamps),
    position: { lat: readField(body, schema.fields.lat), lon: readField(body, schema.fields.lon) },
  };
  if (normalized.odometerMi === undefined) delete normalized.odometerMi;
  return normalized;
}

function validateEnvelope(raw, batch) {
  if (!raw || !raw.header || !raw.body) {
    throw new Error(`Malformed envelope in ${batch.batchId}`);
  }
  if (!raw.header.unit || raw.header.seq === undefined) {
    throw new Error(`Envelope missing unit/seq in ${batch.batchId}`);
  }
  return raw;
}

function normalizeBatch(batch) {
  return batch.messages.map((raw) => normalizeMessage(validateEnvelope(raw, batch)));
}

function applyRouteProgress(events) {
  events.forEach((event) => {
    const route = ROUTES.find((r) => r.routeId === event.routeId);
    if (!route) return;
    if (event.type === 'ROUTE_STARTED') route.status = 'In progress';
    if (event.type === 'CONTAINER_SERVICED') route.serviced = Math.min(route.stopsTotal, route.serviced + 1);
    if (event.type === 'NOT_OUT') route.notOut += 1;
    if (event.type === 'BLOCKED' || event.type === 'CONTAMINATED') route.exceptions += 1;
    if (event.type === 'MILEAGE') route.lastOdometerMi = event.odometerMi;
    if (!route.lastEventAt || event.occurredAt >= route.lastEventAt) {
      route.lastEventAt = event.occurredAt;
      route.lastEventType = event.type;
    }
    route.status = route.serviced >= route.stopsTotal ? 'Complete' : 'In progress';
  });
}

function applyFleetActivity(events) {
  events.forEach((event) => {
    const unit = FLEET.find((u) => u.unitId === event.unitId);
    if (!unit) return;
    if (!unit.lastMessageAt || event.occurredAt >= unit.lastMessageAt) {
      unit.lastMessageAt = event.occurredAt;
      unit.lastSchema = event.schema;
    }
    unit.messagesToday += 1;
    unit.status = 'Reporting';
  });
}

function writeToSinks(events, writtenAt) {
  const writes = { dispatch: 0, billing: 0, reporting: 0 };
  events.forEach((event) => {
    (SINK_ROUTING[event.type] || []).forEach((sinkKey) => {
      writes[sinkKey] += 1;
    });
  });
  Object.keys(writes).forEach((sinkKey) => {
    const sink = SINKS[sinkKey];
    sink.writesToday += writes[sinkKey];
    sink.lastWriteAt = writtenAt;
    sink.status = PARKED.length ? 'Stale' : 'Current';
    sink.lagBatches = PARKED.length;
  });
  return writes;
}

function countByType(events) {
  return events.reduce((acc, event) => {
    acc[event.type] = (acc[event.type] || 0) + 1;
    return acc;
  }, {});
}

function commitBatch(batch, events, run) {
  const writtenAt = new Date().toISOString();
  const writes = writeToSinks(events, writtenAt);
  applyRouteProgress(events);
  applyFleetActivity(events);
  run.eventsWritten = events.length;
  run.sinkWrites = writes;
  run.byType = countByType(events);
  run.unitsReporting = new Set(events.map((e) => e.unitId)).size;
  ingestState.messagesToday += events.length;
  ingestState.lastSuccessfulBatchAt = writtenAt;
  const lastSeq = batch.messages[batch.messages.length - 1].header.seq;
  ingestState.lastBatchId = batch.batchId;
  ingestState.lastBatchSeq = lastSeq;
  if (ingestState.highWaterSeq === null || lastSeq > ingestState.highWaterSeq) ingestState.highWaterSeq = lastSeq;
}

function markDegraded(batch, error, failedAt) {
  ingestState.status = 'degraded';
  ingestState.failedBatches += 1;
  ingestState.lastFailureAt = failedAt;
  ingestState.lastError = `${error.name}: ${error.message}`;
  Object.values(SINKS).forEach((sink) => {
    sink.status = 'Stale';
    sink.lagBatches += 1;
  });
  ROUTES.forEach((route) => {
    if (batch.messages.some((m) => m.header.unit === route.unitId)) route.status = 'Stale — no updates';
  });
  FLEET.forEach((unit) => {
    if (batch.messages.some((m) => m.header.unit === unit.unitId)) unit.status = 'Messages rejected';
  });
}

function parkBatch(batch, run, error) {
  const parkedAt = new Date().toISOString();
  PARKED.push({
    batchId: batch.batchId,
    batchNo: batch.batchNo,
    runId: run.runId,
    parkedAt,
    reason: `${error.name}: ${error.message}`,
    stage: run.stage,
    messageCount: batch.messages.length,
    schemas: summarizeSchemas(batch.messages),
    units: [...new Set(batch.messages.map((m) => m.header.unit))],
    sample: batch.messages.find((m) => m.header.schema !== 'obc/3.2') || batch.messages[0],
    messages: batch.messages,
  });
  return parkedAt;
}

function currentSummary() {
  return {
    status: ingestState.status,
    messagesToday: ingestState.messagesToday,
    failedBatches: ingestState.failedBatches,
    parkedMessages: PARKED.reduce((sum, p) => sum + p.messageCount, 0),
    parkedBatches: PARKED.length,
    lastSuccessfulBatchAt: ingestState.lastSuccessfulBatchAt,
    lastFailureAt: ingestState.lastFailureAt,
    lastError: ingestState.lastError,
    nextBatch: { batchNo: nextBatchNo, batchId: `BATCH-3120-${String(nextBatchNo).padStart(6, '0')}`, messageCount: BATCH_SIZE },
  };
}

function alertData(error, batch, run, meta) {
  const schemas = summarizeSchemas(batch.messages);
  const affectedUnits = [...new Set(batch.messages.filter((m) => m.header.schema !== 'obc/3.2').map((m) => m.header.unit))];
  const sample = batch.messages.find((m) => m.header.schema !== 'obc/3.2') || null;
  return {
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/0a6f5e56-obc-ingest-${batch.batchNo}`,
    culprit: 'app/services/verticals/0a6f5e56.js — normalizeMessage',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: meta.devinUserId,
    devinEmail: meta.devinEmail,
    devinOrgId: meta.devinOrgId,
    slackMemberId: SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    service: SERVICE,
    verticalLabel: 'WM — Onboard Event Ingest (truck telematics → dispatch, billing, reporting)',
    tags: [
      { key: 'route', value: '/api/0a6f5e56/ingest/run' },
      { key: 'service', value: SERVICE },
      { key: 'component', value: 'obc-event-ingest' },
      { key: 'district', value: DISTRICT.id },
      { key: 'batch', value: batch.batchId },
      { key: 'stage', value: run.stage },
      { key: 'vendor', value: VENDOR_ROLLOUT.vendor },
      { key: 'vendor_firmware', value: VENDOR_ROLLOUT.toFirmware },
      { key: 'vendor_change', value: VENDOR_ROLLOUT.changeTicket },
    ],
    extra: {
      requestId: run.requestId,
      batchId: batch.batchId,
      topic: batch.topic,
      messageCount: batch.messages.length,
      schemasInBatch: schemas,
      affectedUnits,
      parkedMessages: PARKED.reduce((sum, p) => sum + p.messageCount, 0),
      sampleRejectedMessage: sample,
      vendorRollout: VENDOR_ROLLOUT,
      sinks: Object.values(SINKS).map((s) => ({ key: s.key, status: s.status, lagBatches: s.lagBatches })),
      replayEndpoint: 'POST /api/0a6f5e56/ingest/replay',
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
    triggeredRule: 'Datadog monitor: obc.ingest.batch.failed > 0 over 5m (district 3120)',
    promptAppendix: [
      '## Incident context',
      `- The onboard-computer (OBC) event ingest for WM hauling district ${DISTRICT.id} (${DISTRICT.name}) rejected ${batch.batchId}: ${batch.messages.length} truck messages from ${DISTRICT.gateway} were rolled back and parked in the dead-letter store (${PARKED.reduce((sum, p) => sum + p.messageCount, 0)} parked in total).`,
      `- The batch mixes message schemas (${Object.entries(schemas).map(([k, v]) => `${k}: ${v}`).join(', ')}); the service currently declares ${Object.keys(MESSAGE_SCHEMAS).join(', ')}. ${VENDOR_ROLLOUT.vendor} began rolling ${VENDOR_ROLLOUT.product} firmware ${VENDOR_ROLLOUT.fromFirmware} → ${VENDOR_ROLLOUT.toFirmware} (${VENDOR_ROLLOUT.changeTicket}) to ${VENDOR_ROLLOUT.unitsUpdated} of ${VENDOR_ROLLOUT.unitsTotal} units in this district. Release notes: ${VENDOR_ROLLOUT.releaseNotes}`,
      `- Affected units on the new firmware in this batch: ${affectedUnits.join(', ')}.`,
      '- Dispatch, billing and reporting have received no events since the failure; every affected route shows stale progress and serviced containers are not reaching billing.',
      '- Sample rejected message (new format):',
      '```json',
      JSON.stringify(sample, null, 2),
      '```',
      '',
      '## Remediation expectations',
      '- Read the service logs and the sample above and tie the failures to the vendor firmware rollout.',
      '- Fix the ingest service so it accepts BOTH the existing obc/3.2 flat messages and the new obc/4.0 nested messages, mapping both onto the same normalized events consumed by dispatch, billing and reporting. Do not drop, skip or down-sample messages from either format.',
      '- Add a unit test covering one message of each schema (route started, container serviced, bin not out, odometer/mileage) that asserts the identical normalized event shape.',
      '- Re-process the parked batch(es) via `POST /api/0a6f5e56/ingest/replay` once the fix is in place and confirm the parked count returns to zero.',
      '- Post a plain-language summary (what broke, why, what changed, what was replayed) in the PR description — a human approves every change; do not merge.',
    ].join('\n'),
  };
}

async function ingestBatch(batch, meta, trigger) {
  const requestId = uuidv4();
  const startedAt = new Date();
  const run = {
    runId: `run-${requestId.slice(0, 8)}`,
    requestId,
    batchId: batch.batchId,
    batchNo: batch.batchNo,
    trigger,
    receivedAt: batch.receivedAt,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    status: 'running',
    stage: 'receive',
    messagesIn: batch.messages.length,
    schemas: summarizeSchemas(batch.messages),
    eventsWritten: 0,
    sinkWrites: { dispatch: 0, billing: 0, reporting: 0 },
    byType: {},
    unitsReporting: 0,
    error: null,
  };
  RUNS.unshift(run);
  if (RUNS.length > 60) RUNS.pop();

  logger.info('OBC ingest batch started', {
    requestId,
    batchId: batch.batchId,
    trigger,
    messages: batch.messages.length,
    schemas: run.schemas,
    district: DISTRICT.id,
    release: RELEASE,
    service: SERVICE,
  });
  const metricTags = [`district:${DISTRICT.id}`, `trigger:${trigger}`, `release:${RELEASE}`];
  incrementMetric('obc.ingest.batch.started', metricTags);

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    run.stage = 'validate';
    batch.messages.forEach((raw) => validateEnvelope(raw, batch));
    run.stage = 'normalize';
    const events = normalizeBatch(batch);
    run.stage = 'commit';
    commitBatch(batch, events, run);

    run.status = 'succeeded';
    run.stage = 'done';
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - startedAt.getTime();
    incrementMetric('obc.ingest.batch.succeeded', metricTags);
    recordMetric('obc.ingest.messages.written', events.length, metricTags);
    recordTiming('obc.ingest.batch.duration', run.durationMs, metricTags);
    logger.info('OBC ingest batch committed', {
      requestId,
      batchId: batch.batchId,
      eventsWritten: events.length,
      sinkWrites: run.sinkWrites,
      durationMs: run.durationMs,
      service: SERVICE,
    });
    return run;
  } catch (error) {
    run.status = 'failed';
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - startedAt.getTime();
    run.error = { type: error.name, message: error.message, stage: run.stage };
    const parkedAt = parkBatch(batch, run, error);
    markDegraded(batch, error, parkedAt);

    incrementMetric('obc.ingest.batch.failed', [...metricTags, `error_type:${error.name}`, `stage:${run.stage}`]);
    recordMetric('obc.ingest.messages.parked', batch.messages.length, metricTags);
    recordTiming('obc.ingest.batch.duration', run.durationMs, metricTags);
    logger.error('OBC ingest batch failed — batch rolled back and parked', {
      requestId,
      batchId: batch.batchId,
      stage: run.stage,
      schemas: run.schemas,
      messagesParked: batch.messages.length,
      sampleSchema: (batch.messages.find((m) => m.header.schema !== 'obc/3.2') || {}).header,
      error: error.message,
      errorClass: error.name,
      stack: error.stack,
      service: SERVICE,
    });

    Sentry.withScope((scope) => {
      scope.setTag('route', '/api/0a6f5e56/ingest/run');
      scope.setTag('service', SERVICE);
      scope.setTag('alert_path', 'instant');
      scope.setTag('component', 'obc-event-ingest');
      scope.setTag('district', DISTRICT.id);
      scope.setTag('batch', batch.batchId);
      scope.setTag('stage', run.stage);
      scope.setContext('batch', { batchId: batch.batchId, topic: batch.topic, schemas: run.schemas, messages: batch.messages.length });
      scope.setContext('vendorRollout', VENDOR_ROLLOUT);
      Sentry.captureException(error);
    });

    if (trigger !== 'replay') {
      createSessionAndAlert(alertData(error, batch, run, meta)).catch((err) => {
        logger.error('Failed to trigger Devin session', { error: err.message, service: SERVICE });
      });
    }
    throw error;
  }
}

async function runNextBatch(meta = {}) {
  const batch = buildBatch(nextBatchNo, new Date());
  nextBatchNo += 1;
  const run = await ingestBatch(batch, meta, meta.trigger || 'manual');
  return { run, summary: currentSummary() };
}

async function replayParked(meta = {}) {
  const parked = PARKED.splice(0, PARKED.length);
  const results = [];
  for (const entry of parked) {
    const batch = {
      batchNo: entry.batchNo,
      batchId: entry.batchId,
      receivedAt: entry.parkedAt,
      source: DISTRICT.gateway,
      topic: DISTRICT.topic,
      messages: entry.messages,
    };
    try {
      results.push(await ingestBatch(batch, meta, 'replay'));
    } catch {
      results.push(RUNS[0]);
    }
  }
  if (PARKED.length === 0 && ingestState.failedBatches > 0) {
    ingestState.status = 'healthy';
    ingestState.lastError = null;
    Object.values(SINKS).forEach((sink) => { sink.status = 'Current'; sink.lagBatches = 0; });
  }
  logger.info('OBC ingest replay finished', { replayed: parked.length, stillParked: PARKED.length, service: SERVICE });
  return { replayed: parked.length, stillParked: PARKED.length, runs: results, summary: currentSummary() };
}

function seedStore() {
  const now = Date.now();
  RUNS = [];
  PARKED = [];
  nextBatchNo = 1;
  rolloutStartedAt = minutesAgo(28, now).toISOString();
  ROUTES = ROUTE_CATALOG.map((route) => ({
    ...route,
    serviced: 0,
    notOut: 0,
    exceptions: 0,
    lastOdometerMi: null,
    lastEventAt: null,
    lastEventType: null,
    status: 'Not started',
  }));
  FLEET = FLEET_CATALOG.map((unit) => ({
    ...unit,
    route: (ROUTE_CATALOG.find((r) => r.unitId === unit.unitId) || {}).routeId || null,
    firmwareUpdatedAt: unit.firmware === VENDOR_ROLLOUT.toFirmware ? minutesAgo(28 - Math.floor(Math.random() * 12), now).toISOString() : null,
    lastMessageAt: null,
    lastSchema: null,
    messagesToday: 0,
    status: 'Idle',
  }));
  SINKS = Object.fromEntries(Object.values(SINK_DEFINITIONS).map((def) => [def.key, { ...def, writesToday: 0, lastWriteAt: null, status: 'Current', lagBatches: 0 }]));
  ingestState = {
    status: 'healthy',
    messagesToday: 0,
    failedBatches: 0,
    lastSuccessfulBatchAt: null,
    lastBatchId: null,
    lastBatchSeq: null,
    highWaterSeq: null,
    lastFailureAt: null,
    lastError: null,
  };

  for (let i = 1; i <= SEEDED_BATCHES; i += 1) {
    const receivedAt = minutesAgo((SEEDED_BATCHES - i + 1) * DISTRICT.cadenceMinutes + 20, now);
    const batch = buildBatch(i, receivedAt);
    const events = normalizeBatch(batch);
    const run = {
      runId: `run-seed-${String(i).padStart(4, '0')}`,
      requestId: uuidv4(),
      batchId: batch.batchId,
      batchNo: i,
      trigger: 'scheduled',
      receivedAt: batch.receivedAt,
      startedAt: new Date(receivedAt.getTime() + 1200).toISOString(),
      finishedAt: new Date(receivedAt.getTime() + 1200 + 140 + i * 9).toISOString(),
      durationMs: 140 + i * 9,
      status: 'succeeded',
      stage: 'done',
      messagesIn: batch.messages.length,
      schemas: summarizeSchemas(batch.messages),
      eventsWritten: 0,
      sinkWrites: null,
      byType: {},
      unitsReporting: 0,
      error: null,
    };
    commitBatch(batch, events, run);
    const writtenAt = run.finishedAt;
    Object.values(SINKS).forEach((sink) => { sink.lastWriteAt = writtenAt; });
    ingestState.lastSuccessfulBatchAt = writtenAt;
    RUNS.unshift(run);
    nextBatchNo = i + 1;
  }
  logger.info('OBC ingest store seeded', { batches: SEEDED_BATCHES, messages: ingestState.messagesToday, service: SERVICE });
}

function getOverview() {
  return {
    service: SERVICE,
    release: RELEASE,
    district: DISTRICT,
    vendorRollout: { ...VENDOR_ROLLOUT, startedAt: rolloutStartedAt },
    summary: currentSummary(),
    sinks: Object.values(SINKS),
    routes: ROUTES,
    fleet: FLEET,
    schemasSupported: Object.keys(MESSAGE_SCHEMAS),
    runs: RUNS,
    parked: PARKED.map((entry) => ({ ...entry, messages: undefined })),
  };
}

function listRuns() {
  return RUNS;
}

function listParked() {
  return PARKED;
}

function resetIngest() {
  const cleared = { runs: RUNS.length, parked: PARKED.length };
  seedStore();
  logger.info('OBC ingest demo state reset', { ...cleared, service: SERVICE });
  incrementMetric('obc.ingest.reset', [`district:${DISTRICT.id}`]);
  return { success: true, cleared, summary: currentSummary() };
}

seedStore();

module.exports = {
  runNextBatch,
  replayParked,
  resetIngest,
  getOverview,
  listRuns,
  listParked,
  normalizeMessage,
  buildBatch,
  DISTRICT,
  VENDOR_ROLLOUT,
  ROUTE_CATALOG,
  FLEET_CATALOG,
  SINK_ROUTING,
};
