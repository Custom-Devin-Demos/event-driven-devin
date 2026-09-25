const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { LINE_MANIFESTS, getLineManifest } = require('./1182181f-line-manifests');

const SERVICE = '1182181f-mes-ingest';
const PLANT = { code: 'P07', name: 'Kingsport Engine Plant', company: 'Talon Power Systems', timezone: 'America/New_York' };
const STAGES = ['read_historian', 'decode', 'aggregate_interval', 'evaluate_alarms', 'publish'];
const INTERVAL_MIN = 15;
const STALE_AFTER_MS = Number(process.env.X1182181F_STALE_AFTER_MS) || 60 * 60 * 1000;
const ALERT_COOLDOWN_MS = Number(process.env.X1182181F_ALERT_COOLDOWN_MS) || 24 * 60 * 60 * 1000;
const CUTOVER_AGO_MS = 26 * 60 * 60 * 1000;

const LINES = {};
const CELLS = {};
const ALARMS = [];
const RUNS = [];
const MAX_RUNS = 500;
const MAX_RUNS_PAGE = 200;
const failureTimestamps = [];
const consecutiveFailures = {};
const lastAlerts = {};
const lastSuccessfulPublishes = {};
let schedulerHandle = null;
let alarmSequence = 20481;

// ISA-88 / PackML (ANSI/ISA-TR88.00.02) StateCurrent enumeration.
const PACKML_STATES = {
  0: { name: 'Undefined', category: 'down' },
  1: { name: 'Clearing', category: 'down' },
  2: { name: 'Stopped', category: 'down' },
  3: { name: 'Starting', category: 'idle' },
  4: { name: 'Idle', category: 'idle' },
  5: { name: 'Suspended', category: 'idle' },
  6: { name: 'Execute', category: 'running' },
  7: { name: 'Stopping', category: 'down' },
  8: { name: 'Aborting', category: 'down' },
  9: { name: 'Aborted', category: 'down' },
  10: { name: 'Holding', category: 'idle' },
  11: { name: 'Held', category: 'idle' },
  12: { name: 'Unholding', category: 'idle' },
  13: { name: 'Suspending', category: 'idle' },
  14: { name: 'Unsuspending', category: 'idle' },
  15: { name: 'Resetting', category: 'idle' },
  16: { name: 'Completing', category: 'running' },
  17: { name: 'Complete', category: 'idle' },
};

// MTConnect Execution DataItem values.
const MTCONNECT_EXECUTION = {
  ACTIVE: { name: 'ACTIVE', category: 'running' },
  READY: { name: 'READY', category: 'idle' },
  INTERRUPTED: { name: 'INTERRUPTED', category: 'down' },
  FEED_HOLD: { name: 'FEED_HOLD', category: 'idle' },
  STOPPED: { name: 'STOPPED', category: 'down' },
  OPTIONAL_STOP: { name: 'OPTIONAL_STOP', category: 'idle' },
  PROGRAM_STOPPED: { name: 'PROGRAM_STOPPED', category: 'idle' },
  PROGRAM_COMPLETED: { name: 'PROGRAM_COMPLETED', category: 'idle' },
  UNAVAILABLE: { name: 'UNAVAILABLE', category: 'down' },
};

const STATE_MODELS = {
  packml: { decode: (raw) => PACKML_STATES[Number(raw)] || PACKML_STATES[0] },
  'mtconnect-execution': { decode: (raw) => MTCONNECT_EXECUTION[String(raw)] || MTCONNECT_EXECUTION.UNAVAILABLE },
};

// Sample-quality decoders keyed by the encoding the line's adapter stamps on
// each historian row. OPC DA carries an 8-bit quality byte (bits 7–6: major
// quality). MTConnect exposes AVAILABLE / UNAVAILABLE on the device.
const QUALITY_DECODERS = {
  opcda: {
    decode: (raw) => {
      const major = Number(raw) & 0xC0;
      if (major === 0xC0) return 'GOOD';
      if (major === 0x40) return 'UNCERTAIN';
      return 'BAD';
    },
  },
  mtconnect: {
    decode: (raw) => (String(raw).toUpperCase() === 'UNAVAILABLE' ? 'BAD' : 'GOOD'),
  },
};

// Downtime reason codes as configured in the MES reason tree (Category | Reason).
const DOWNTIME_REASONS = {
  0: null,
  101: 'Set Up | Changeover',
  115: 'No Operator | Break',
  202: 'Machine | Torque tool fault',
  214: 'Machine | Fixture clamp not confirmed',
  305: 'Material | Upstream starved',
  306: 'Material | Downstream blocked',
  410: 'Machine | Coolant level low',
  418: 'Machine | Spindle overload',
  433: 'Tooling | Tool life expired',
  512: 'Quality | SPC hold',
  610: 'Machine | Dyno cell not ready',
  623: 'Machine | Fuel supply pressure low',
  701: 'No Operator | Not staffed',
  702: 'Material | Waiting on parts',
  703: 'Quality | First-piece inspection',
};
const IDLE_REASON_POOL = [115, 702, 703, 701, 305];
const SHIFT_HOURS = 8;

const CELL_SEEDS = {
  L1: [
    ['BM-101', 'ACTIVE', 41.6, 0],
    ['BM-102', 'ACTIVE', 40.9, 0],
    ['BM-103', 'INTERRUPTED', 0, 433],
    ['BM-104', 'ACTIVE', 42.3, 0],
    ['BM-105', 'ACTIVE', 41.1, 0],
    ['BM-106', 'ACTIVE', 40.4, 0],
  ],
  L2: [
    ['HM-201', 'ACTIVE', 57.2, 0],
    ['HM-202', 'ACTIVE', 58.4, 0],
    ['HM-203', 'ACTIVE', 55.9, 0],
    ['HM-204', 'ACTIVE', 54.1, 0],
  ],
  L3: [
    ['FA-301', 6, 35.4, 0],
    ['FA-302', 6, 35.4, 0],
    ['FA-303', 6, 35.4, 0],
    ['FA-304', 11, 0, 202],
    ['FA-305', 6, 35.4, 0],
    ['FA-306', 6, 35.4, 0],
    ['FA-307', 6, 35.4, 0],
    ['FA-308', 6, 35.4, 0],
  ],
  L4: [
    ['HT-401', 6, 29.1, 0],
    ['HT-402', 6, 30.2, 0],
    ['HT-403', 4, 0, 610],
    ['HT-404', 6, 28.7, 0],
  ],
};

// Current production order per cell as dispatched from the ERP/MES schedule.
const CELL_JOBS = {
  'BM-101': { workOrder: '4417820', operation: 'OP10', partNumber: '3117-4402', partName: 'Block, 6.7L I6', operator: 'M. Delgado', expectedCycleSec: 86, setupAtStart: false },
  'BM-102': { workOrder: '4417820', operation: 'OP20', partNumber: '3117-4402', partName: 'Block, 6.7L I6', operator: 'M. Delgado', expectedCycleSec: 88, setupAtStart: false },
  'BM-103': { workOrder: '4417820', operation: 'OP30', partNumber: '3117-4402', partName: 'Block, 6.7L I6', operator: 'R. Quintero', expectedCycleSec: 86, setupAtStart: false, controlAlarm: 'EX1023 TOOL LIFE EXPIRED T07' },
  'BM-104': { workOrder: '4417831', operation: 'OP10', partNumber: '3117-4410', partName: 'Block, 9.0L I6', operator: 'R. Quintero', expectedCycleSec: 85, setupAtStart: true },
  'BM-105': { workOrder: '4417831', operation: 'OP20', partNumber: '3117-4410', partName: 'Block, 9.0L I6', operator: 'K. Whitfield', expectedCycleSec: 87, setupAtStart: false },
  'BM-106': { workOrder: '4417831', operation: 'OP30', partNumber: '3117-4410', partName: 'Block, 9.0L I6', operator: 'K. Whitfield', expectedCycleSec: 89, setupAtStart: false },
  'HM-201': { workOrder: '4417902', operation: 'OP10', partNumber: '3204-1180', partName: 'Head, 6.7L 4V', operator: 'T. Nakamura', expectedCycleSec: 62, setupAtStart: false },
  'HM-202': { workOrder: '4417902', operation: 'OP20', partNumber: '3204-1180', partName: 'Head, 6.7L 4V', operator: 'T. Nakamura', expectedCycleSec: 61, setupAtStart: true },
  'HM-203': { workOrder: '4417902', operation: 'OP30', partNumber: '3204-1180', partName: 'Head, 6.7L 4V', operator: 'A. Boateng', expectedCycleSec: 64, setupAtStart: false },
  'HM-204': { workOrder: '4417902', operation: 'OP40', partNumber: '3204-1180', partName: 'Head, 6.7L 4V', operator: 'A. Boateng', expectedCycleSec: 66, setupAtStart: false },
  'FA-301': { workOrder: '4418017', operation: 'ST010', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'J. Pruitt', expectedCycleSec: 100, setupAtStart: false },
  'FA-302': { workOrder: '4418017', operation: 'ST020', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'J. Pruitt', expectedCycleSec: 100, setupAtStart: false },
  'FA-303': { workOrder: '4418017', operation: 'ST030', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'S. Ferreira', expectedCycleSec: 100, setupAtStart: false },
  'FA-304': { workOrder: '4418017', operation: 'ST040', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'S. Ferreira', expectedCycleSec: 100, setupAtStart: false, controlAlarm: 'PF6000 NOK — torque low, bolt 3 of 14' },
  'FA-305': { workOrder: '4418017', operation: 'ST050', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'D. Marsh', expectedCycleSec: 100, setupAtStart: false },
  'FA-306': { workOrder: '4418017', operation: 'ST060', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'D. Marsh', expectedCycleSec: 100, setupAtStart: false },
  'FA-307': { workOrder: '4418017', operation: 'ST070', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'L. Okafor', expectedCycleSec: 100, setupAtStart: false },
  'FA-308': { workOrder: '4418017', operation: 'ST080', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'L. Okafor', expectedCycleSec: 100, setupAtStart: false },
  'HT-401': { workOrder: '4418017', operation: 'HT01', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'C. Reyes', expectedCycleSec: 120, setupAtStart: false },
  'HT-402': { workOrder: '4418017', operation: 'HT02', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'C. Reyes', expectedCycleSec: 120, setupAtStart: false },
  'HT-403': { workOrder: '4418017', operation: 'HT03', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'B. Haldane', expectedCycleSec: 120, setupAtStart: false, controlAlarm: 'F0231 TEST CELL INTERLOCK — COOLANT SUPPLY NOT READY' },
  'HT-404': { workOrder: '4418017', operation: 'HT04', partNumber: 'TPS-670-IND', partName: 'Engine, 6.7L industrial', operator: 'B. Haldane', expectedCycleSec: 120, setupAtStart: false },
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

function sourceValue(manifest, canonical, value) {
  return { [manifest.columns[canonical]]: value };
}

function encodeQuality(manifest, good) {
  switch (manifest.quality.encoding) {
    case 'opcda': return good ? 0xC0 : 0x00;
    case 'mtconnect': return good ? 'AVAILABLE' : 'UNAVAILABLE';
    case 'opcua-statuscode': return good ? 0x00000000 : 0x80000000;
    default: return good;
  }
}

function clearStore() {
  Object.keys(LINES).forEach((key) => delete LINES[key]);
  Object.keys(CELLS).forEach((key) => delete CELLS[key]);
  ALARMS.splice(0, ALARMS.length);
  RUNS.splice(0, RUNS.length);
  failureTimestamps.splice(0, failureTimestamps.length);
  Object.keys(consecutiveFailures).forEach((key) => delete consecutiveFailures[key]);
  Object.keys(lastAlerts).forEach((key) => delete lastAlerts[key]);
  Object.keys(lastSuccessfulPublishes).forEach((key) => delete lastSuccessfulPublishes[key]);
  alarmSequence = 20481;
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

function nextAlarmId() {
  alarmSequence += 1;
  return `ALM-${alarmSequence}`;
}

function plantClock(now) {
  const parts = new Intl.DateTimeFormat('en-US', {
    hour: 'numeric', minute: 'numeric', hour12: false, timeZone: PLANT.timezone,
  }).formatToParts(new Date(now));
  const read = (type) => Number(parts.find((part) => part.type === type).value);
  return { hour: read('hour') % 24, minute: read('minute') };
}

function currentShift(now) {
  const { hour, minute } = plantClock(now);
  let shift;
  if (hour >= 6 && hour < 14) shift = { id: 1, label: '1st shift', window: '06:00–14:00', startHour: 6 };
  else if (hour >= 14 && hour < 22) shift = { id: 2, label: '2nd shift', window: '14:00–22:00', startHour: 14 };
  else shift = { id: 3, label: '3rd shift', window: '22:00–06:00', startHour: 22 };
  let minutesIn = (hour - shift.startHour) * 60 + minute;
  if (minutesIn < 0) minutesIn += 24 * 60;
  const startsAt = now - minutesIn * 60 * 1000 - (now % 60000);
  return {
    id: shift.id,
    label: shift.label,
    window: shift.window,
    startsAt: new Date(startsAt).toISOString(),
    endsAt: new Date(startsAt + SHIFT_HOURS * 60 * 60 * 1000).toISOString(),
    elapsedMin: minutesIn,
  };
}

// Machine-state timeline for the current shift, minute resolution, oldest first.
// Mirrors what the MES execution ribbon shows: mostly in-cycle with short
// load/unload gaps, the occasional categorised stop, and the live state at the end.
function buildShiftTimeline({ manifest, state, reasonCode, job, shiftStartMs, now, random, stateSinceMin }) {
  const elapsed = Math.max(1, Math.floor((now - shiftStartMs) / 60000));
  const segments = [];
  const push = (start, end, category, label, reason) => {
    if (end > start) segments.push({ start, end, category, state: label, reason: reason || null });
  };
  if (manifest.code === 'L4') {
    push(0, elapsed, 'unknown', 'Not Reporting', null);
    return { segments, elapsed };
  }
  const liveStart = state.category === 'running' ? elapsed : Math.max(0, elapsed - stateSinceMin);
  let cursor;
  if (job.setupAtStart) {
    const setupMin = 18 + Math.floor(random() * 17);
    push(0, Math.min(setupMin, liveStart), 'setup', 'Setup', DOWNTIME_REASONS[101]);
    cursor = Math.min(setupMin, liveStart);
  } else {
    const startupDelay = 2 + Math.floor(random() * 9);
    push(0, Math.min(startupDelay, liveStart), 'idle', 'Idle', null);
    cursor = Math.min(startupDelay, liveStart);
  }
  while (cursor < liveStart) {
    const runMin = 8 + Math.floor(random() * 15);
    const runEnd = Math.min(cursor + runMin, liveStart);
    push(cursor, runEnd, 'running', 'Active', null);
    cursor = runEnd;
    if (cursor >= liveStart) break;
    const longStop = random() < 0.12;
    const idleMin = longStop ? 6 + Math.floor(random() * 10) : 1 + Math.floor(random() * 3);
    const idleEnd = Math.min(cursor + idleMin, liveStart);
    const reason = longStop ? DOWNTIME_REASONS[IDLE_REASON_POOL[Math.floor(random() * IDLE_REASON_POOL.length)]] : null;
    push(cursor, idleEnd, 'idle', 'Idle', reason);
    cursor = idleEnd;
  }
  if (state.category !== 'running') {
    push(liveStart, elapsed, state.category, state.name, DOWNTIME_REASONS[reasonCode] || null);
  }
  return { segments, elapsed };
}

function buildLine(manifest, now, random) {
  const seeds = CELL_SEEDS[manifest.code];
  const running = seeds.filter((seed) => seed[2] > 0);
  const ratePerHr = round(running.reduce((sum, seed) => sum + seed[2], 0) / Math.max(running.length, 1), 1);
  const availability = round(running.length / seeds.length, 3);
  const performance = round(Math.min(ratePerHr / manifest.targetRatePerHr, 1.05), 3);
  const good = Math.round(manifest.targetRatePerHr * 7.4 * availability * performance);
  const reject = Math.round(good * (manifest.code === 'L3' ? 0.032 : 0.009 + random() * 0.006));
  const quality = round(good / (good + reject), 3);
  const oee = round(availability * performance * quality, 3);
  const oeeHistory = Array.from({ length: 16 }, (_, index) => (index === 15
    ? oee
    : round(oee + Math.sin(index / 2.3) * 0.03 + (random() - 0.5) * 0.03, 3)));
  return {
    code: manifest.code,
    name: manifest.name,
    area: manifest.area,
    controller: manifest.controller,
    adapter: manifest.adapter,
    protocol: manifest.protocol,
    scanClass: manifest.scanClass,
    manifestVersion: manifest.manifestVersion,
    stateModel: manifest.stateModel,
    qualityEncoding: manifest.quality.encoding,
    targetRatePerHr: manifest.targetRatePerHr,
    ratePerHr,
    shiftGoodCount: good,
    shiftRejectCount: reject,
    shiftDowntimeMin: manifest.code === 'L3' ? 47 : Math.round(8 + random() * 14),
    availability,
    performance,
    quality,
    oee,
    oeeHistory,
    lastPublishedAt: new Date(now).toISOString(),
  };
}

function buildCell(manifest, [cellId, rawState, rate, reasonCode], now, random, shiftStartMs) {
  const state = STATE_MODELS[manifest.stateModel].decode(rawState);
  const job = CELL_JOBS[cellId];
  const stateSinceMin = state.category === 'running'
    ? round(0.5 + random() * 8.5, 1)
    : 12 + Math.floor(random() * 36);
  const timeline = buildShiftTimeline({ manifest, state, reasonCode, job, shiftStartMs, now, random, stateSinceMin });
  const runningMin = timeline.segments.filter((segment) => segment.category === 'running')
    .reduce((sum, segment) => sum + (segment.end - segment.start), 0);
  const firstActive = timeline.segments.find((segment) => segment.category === 'running');
  const reporting = manifest.code !== 'L4';
  const utilization = reporting ? round(runningMin / timeline.elapsed, 3) : 0;
  const utilizationBaseline = round(0.58 + random() * 0.16, 3);
  const cycleRate = rate > 0 ? rate : manifest.targetRatePerHr;
  const partsGood = reporting ? Math.round((cycleRate / 60) * runningMin) : null;
  const partsReject = reporting ? Math.round(partsGood * (manifest.code === 'L3' ? 0.032 : 0.01)) : null;
  return {
    cellId,
    lineCode: manifest.code,
    stateRaw: rawState,
    state: state.name,
    category: reporting ? state.category : 'unknown',
    stateSince: new Date(now - stateSinceMin * 60 * 1000).toISOString(),
    firstActiveAt: firstActive ? new Date(shiftStartMs + firstActive.start * 60 * 1000).toISOString() : null,
    ratePerHr: rate,
    downtimeReasonCode: reasonCode,
    downtimeReason: DOWNTIME_REASONS[reasonCode],
    controlAlarm: state.category !== 'running' ? job.controlAlarm || null : null,
    workOrder: job.workOrder,
    operation: job.operation,
    partNumber: job.partNumber,
    partName: job.partName,
    operator: job.operator,
    expectedCycleSec: job.expectedCycleSec,
    actualCycleSec: rate > 0 ? round(3600 / rate, 1) : null,
    utilization,
    utilizationBaseline,
    partsGood,
    partsReject,
    partsGoal: manifest.targetRatePerHr * SHIFT_HOURS,
    timeline: timeline.segments,
    quality: 'GOOD',
    lastSampleAt: new Date(now - Math.floor(random() * 4000)).toISOString(),
  };
}

function addSeedRun({ manifest, trigger, status, stageReached, rowsIn, rowsOut, startedAt, error, random }) {
  const runId = `job-${Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0')}`;
  const durationMs = status === 'succeeded'
    ? 820 + Math.floor(random() * 640)
    : 310 + Math.floor(random() * 220);
  return recordRun({
    runId,
    lineCode: manifest.code,
    lineName: manifest.name,
    trigger,
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(startedAt + durationMs).toISOString(),
    durationMs,
    stageReached,
    status,
    rowsIn,
    rowsOut,
    error,
  });
}

function seedAlarm({ tag, lineCode, cellId, description, priority, state, value, limit, eu, activeAt, ackBy }) {
  ALARMS.push({
    id: nextAlarmId(),
    tag,
    lineCode,
    cellId,
    description,
    priority,
    state,
    value,
    limit,
    eu,
    activeAt: new Date(activeAt).toISOString(),
    ackBy: ackBy || null,
    ackAt: ackBy ? new Date(activeAt + 4 * 60 * 1000).toISOString() : null,
    rtnAt: null,
  });
}

function seedStore(now = Date.now()) {
  clearStore();
  const random = mulberry32(0x1182181f);
  const shiftStartMs = new Date(currentShift(now).startsAt).getTime();
  Object.values(LINE_MANIFESTS).forEach((manifest) => {
    const isCutover = manifest.code === 'L4';
    const lineNow = isCutover ? now - CUTOVER_AGO_MS : now - 3 * 60 * 1000 - Math.floor(random() * 90 * 1000);
    LINES[manifest.code] = buildLine(manifest, lineNow, random);
    CELL_SEEDS[manifest.code].forEach((seed) => {
      CELLS[seed[0]] = buildCell(manifest, seed, isCutover ? now : lineNow, random, shiftStartMs);
      if (isCutover) {
        CELLS[seed[0]].quality = 'STALE';
        CELLS[seed[0]].lastSampleAt = new Date(lineNow).toISOString();
        CELLS[seed[0]].stateSince = new Date(lineNow).toISOString();
      }
    });

    if (!isCutover) {
      let latest = null;
      for (let index = 0; index < 8; index += 1) {
        const startedAt = now - ((8 - index) * INTERVAL_MIN * 60 * 1000) - 2 * 60 * 1000;
        latest = addSeedRun({
          manifest,
          trigger: 'scheduled',
          status: 'succeeded',
          stageReached: 'publish',
          rowsIn: manifest.cells.length * 60,
          rowsOut: manifest.cells.length,
          startedAt,
          error: null,
          random,
        });
      }
      lastSuccessfulPublishes[manifest.code] = new Date(latest.finishedAt).getTime();
      LINES[manifest.code].lastPublishedAt = latest.finishedAt;
    } else {
      const lastGood = addSeedRun({
        manifest,
        trigger: 'scheduled',
        status: 'succeeded',
        stageReached: 'publish',
        rowsIn: manifest.cells.length * 60,
        rowsOut: manifest.cells.length,
        startedAt: now - CUTOVER_AGO_MS - INTERVAL_MIN * 60 * 1000,
        error: null,
        random,
      });
      lastSuccessfulPublishes[manifest.code] = new Date(lastGood.finishedAt).getTime();
      LINES[manifest.code].lastPublishedAt = lastGood.finishedAt;
      [26 * 60 - 12, 20 * 60 - 3, 12 * 60 + 9, 4 * 60 + 2, 47, 17].forEach((minutesAgo) => addSeedRun({
        manifest,
        trigger: 'scheduled',
        status: 'failed',
        stageReached: 'decode',
        rowsIn: manifest.cells.length * 60,
        rowsOut: 0,
        startedAt: now - minutesAgo * 60 * 1000,
        error: {
          name: 'TypeError',
          message: "Cannot read properties of undefined (reading 'decode')",
          stage: 'decode',
        },
        random,
      }));
      consecutiveFailures.L4 = 6;
    }
  });

  seedAlarm({
    tag: 'L3_FA304_Torque_Fault', lineCode: 'L3', cellId: 'FA-304', description: 'Torque tool fault — head bolt sequence 3 not confirmed', priority: 'HIGH', state: 'ACTIVE_UNACK', value: 1, limit: 0, eu: 'bool', activeAt: now - 23 * 60 * 1000,
  });
  seedAlarm({
    tag: 'L3_Reject_Rate_Hi', lineCode: 'L3', cellId: null, description: 'Shift reject rate above 3.0 % limit', priority: 'MEDIUM', state: 'ACTIVE_ACK', value: 3.1, limit: 3.0, eu: '%', activeAt: now - 71 * 60 * 1000, ackBy: 'dmarsh',
  });
  seedAlarm({
    tag: 'L1_BM103_Tool_Life', lineCode: 'L1', cellId: 'BM-103', description: 'Tool life expired — T07 rough bore', priority: 'MEDIUM', state: 'ACTIVE_ACK', value: 0, limit: 5, eu: '%', activeAt: now - 38 * 60 * 1000, ackBy: 'rquintero',
  });
  seedAlarm({
    tag: 'L2_HM204_Spindle_Load_Hi', lineCode: 'L2', cellId: 'HM-204', description: 'Spindle load above 92 % for > 30 s', priority: 'HIGH', state: 'ACTIVE_UNACK', value: 96.4, limit: 92.0, eu: '%', activeAt: now - 9 * 60 * 1000,
  });
  seedAlarm({
    tag: 'L1_Coolant_Sump_Lo', lineCode: 'L1', cellId: null, description: 'Central coolant sump level low', priority: 'LOW', state: 'ACTIVE_ACK', value: 31, limit: 35, eu: '%', activeAt: now - 3 * 60 * 60 * 1000, ackBy: 'dmarsh',
  });
  seedAlarm({
    tag: 'P07_MES_L4_Ingest_Stale', lineCode: 'L4', cellId: null, description: 'No MES publish from Line 4 historian ingest in > 60 min', priority: 'CRITICAL', state: 'ACTIVE_UNACK', value: 26, limit: 1, eu: 'h', activeAt: now - CUTOVER_AGO_MS + 60 * 60 * 1000,
  });
}

function readHistorian(manifest, now) {
  const rows = [];
  const samplesPerCell = 4;
  CELL_SEEDS[manifest.code].forEach(([cellId, rawState, rate, reasonCode], cellIndex) => {
    const cell = CELLS[cellId];
    for (let sample = 0; sample < samplesPerCell; sample += 1) {
      const sampleTime = new Date(now - (samplesPerCell - sample) * (INTERVAL_MIN / samplesPerCell) * 60 * 1000).toISOString();
      const running = cell ? cell.category === 'running' : rate > 0;
      const good = running ? Math.round((rate / 60) * (INTERVAL_MIN / samplesPerCell) * (0.9 + Math.random() * 0.2)) : 0;
      const reject = running && Math.random() < (manifest.code === 'L3' ? 0.11 : 0.03) ? 1 : 0;
      rows.push({
        ...sourceValue(manifest, 'sampleTime', sampleTime),
        ...sourceValue(manifest, 'lineId', `${PLANT.code}.${manifest.code}`),
        ...sourceValue(manifest, 'cellId', cellId),
        ...sourceValue(manifest, 'state', rawState),
        ...sourceValue(manifest, 'rate', running ? round(rate + (Math.random() - 0.5) * 1.6, 1) : 0),
        ...sourceValue(manifest, 'goodCount', good),
        ...sourceValue(manifest, 'rejectCount', reject),
        ...sourceValue(manifest, 'quality', encodeQuality(manifest, !(cellIndex === 2 && sample === 0 && manifest.code === 'L1'))),
        ...sourceValue(manifest, 'downtimeReason', reasonCode),
      });
    }
  });
  return { rows, rowsIn: rows.length };
}

function decodeQuality(manifest, raw) {
  return QUALITY_DECODERS[manifest.quality.encoding].decode(raw);
}

function decodeSamples(manifest, rawRows) {
  const stateModel = STATE_MODELS[manifest.stateModel];
  return rawRows.map((raw) => {
    const row = {};
    Object.keys(manifest.columns).forEach((canonical) => {
      row[canonical] = raw[manifest.columns[canonical]];
    });
    const state = stateModel.decode(row.state);
    row.stateRaw = row.state;
    row.state = state.name;
    row.category = state.category;
    row.quality = decodeQuality(manifest, row.quality);
    row.downtimeReason = DOWNTIME_REASONS[row.downtimeReason] || null;
    row.downtimeReasonCode = raw[manifest.columns.downtimeReason];
    row.lineCode = manifest.code;
    return row;
  });
}

function aggregateInterval(manifest, rows) {
  const byCell = {};
  rows.forEach((row) => {
    if (!byCell[row.cellId]) byCell[row.cellId] = [];
    byCell[row.cellId].push(row);
  });
  const cells = Object.entries(byCell).map(([cellId, samples]) => {
    const goodSamples = samples.filter((sample) => sample.quality === 'GOOD');
    const latest = samples[samples.length - 1];
    const running = goodSamples.filter((sample) => sample.category === 'running').length;
    return {
      cellId,
      lineCode: manifest.code,
      stateRaw: latest.stateRaw,
      state: latest.state,
      category: latest.category,
      ratePerHr: round(goodSamples.reduce((sum, sample) => sum + Number(sample.rate), 0) / Math.max(goodSamples.length, 1), 1),
      goodCount: samples.reduce((sum, sample) => sum + Number(sample.goodCount), 0),
      rejectCount: samples.reduce((sum, sample) => sum + Number(sample.rejectCount), 0),
      runtimeMin: round((running / samples.length) * INTERVAL_MIN, 1),
      badSamples: samples.length - goodSamples.length,
      downtimeReasonCode: latest.downtimeReasonCode,
      downtimeReason: latest.downtimeReason,
      quality: latest.quality,
      lastSampleAt: latest.sampleTime,
    };
  });
  const runtimeMin = cells.reduce((sum, cell) => sum + cell.runtimeMin, 0) / cells.length;
  const good = cells.reduce((sum, cell) => sum + cell.goodCount, 0);
  const reject = cells.reduce((sum, cell) => sum + cell.rejectCount, 0);
  const runningCells = cells.filter((cell) => cell.category === 'running');
  const ratePerHr = round(runningCells.reduce((sum, cell) => sum + cell.ratePerHr, 0) / Math.max(runningCells.length, 1), 1);
  const availability = round(runtimeMin / INTERVAL_MIN, 3);
  const performance = round(Math.min(ratePerHr / manifest.targetRatePerHr, 1.05), 3);
  const quality = round(good + reject ? good / (good + reject) : 1, 3);
  return {
    lineCode: manifest.code,
    cells,
    ratePerHr,
    goodCount: good,
    rejectCount: reject,
    downtimeMin: round(INTERVAL_MIN - runtimeMin, 1),
    availability,
    performance,
    quality,
    oee: round(availability * performance * quality, 3),
  };
}

function evaluateAlarms(manifest, interval, now = Date.now()) {
  const found = [];
  if (interval.ratePerHr > 0 && interval.ratePerHr < manifest.targetRatePerHr * 0.8) {
    found.push({
      tag: `${manifest.code}_Rate_Lo`, lineCode: manifest.code, cellId: null, description: 'Line rate below 80 % of target', priority: 'MEDIUM', value: interval.ratePerHr, limit: round(manifest.targetRatePerHr * 0.8, 1), eu: 'units/h',
    });
  }
  const rejectPct = interval.goodCount + interval.rejectCount
    ? round((interval.rejectCount / (interval.goodCount + interval.rejectCount)) * 100, 1) : 0;
  if (rejectPct > 3.0) {
    found.push({
      tag: `${manifest.code}_Reject_Rate_Hi`, lineCode: manifest.code, cellId: null, description: 'Shift reject rate above 3.0 % limit', priority: 'MEDIUM', value: rejectPct, limit: 3.0, eu: '%',
    });
  }
  interval.cells.filter((cell) => cell.category === 'down' && cell.downtimeReasonCode).forEach((cell) => {
    found.push({
      tag: `${manifest.code}_${cell.cellId.replace('-', '')}_Down`, lineCode: manifest.code, cellId: cell.cellId, description: `Cell down — ${cell.downtimeReason}`, priority: 'HIGH', value: cell.downtimeReasonCode, limit: 0, eu: 'code',
    });
  });
  return found.map((alarm) => ({ ...alarm, state: 'ACTIVE_UNACK', activeAt: new Date(now).toISOString(), ackBy: null, ackAt: null, rtnAt: null }));
}

function publish(manifest, interval, alarms, run) {
  const publishedAt = new Date().toISOString();
  const line = LINES[manifest.code];
  interval.cells.forEach((cell) => {
    CELLS[cell.cellId] = { ...CELLS[cell.cellId], ...cell };
  });
  line.ratePerHr = interval.ratePerHr;
  line.shiftGoodCount += interval.goodCount;
  line.shiftRejectCount += interval.rejectCount;
  line.shiftDowntimeMin = round(line.shiftDowntimeMin + interval.downtimeMin, 1);
  line.availability = interval.availability;
  line.performance = interval.performance;
  line.quality = interval.quality;
  line.oee = interval.oee;
  line.oeeHistory = [...line.oeeHistory, interval.oee].slice(-16);
  line.lastPublishedAt = publishedAt;

  ALARMS.filter((alarm) => alarm.lineCode === manifest.code && alarm.state.startsWith('ACTIVE') && alarm.tag.match(/_(Rate_Lo|Reject_Rate_Hi|Down)$/))
    .forEach((alarm) => {
      const still = alarms.find((candidate) => candidate.tag === alarm.tag);
      if (still) {
        alarm.value = still.value;
      } else {
        alarm.state = alarm.ackBy ? 'RTN_ACK' : 'RTN_UNACK';
        alarm.rtnAt = publishedAt;
      }
    });
  alarms.forEach((alarm) => {
    const existing = ALARMS.find((candidate) => candidate.tag === alarm.tag && candidate.state.startsWith('ACTIVE'));
    if (!existing) ALARMS.push({ id: nextAlarmId(), ...alarm });
  });
  const staleAlarm = ALARMS.find((alarm) => alarm.tag === `${PLANT.code}_MES_${manifest.code}_Ingest_Stale` && alarm.state.startsWith('ACTIVE'));
  if (staleAlarm) {
    staleAlarm.state = staleAlarm.ackBy ? 'RTN_ACK' : 'RTN_UNACK';
    staleAlarm.rtnAt = publishedAt;
  }

  lastSuccessfulPublishes[manifest.code] = new Date(publishedAt).getTime();
  consecutiveFailures[manifest.code] = 0;
  run.finishedAt = publishedAt;
  run.durationMs = new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime();
  run.stageReached = 'publish';
  run.status = 'succeeded';
  run.rowsOut = interval.cells.length;
  return recordRun(run, { prepend: true });
}

function staleHoursFor(lineCode, now) {
  const last = lastSuccessfulPublishes[lineCode];
  return last ? Math.round((now - last) / 3600000) : null;
}

async function sendAlert({ error, manifest, run, stage, requestId, rowsIn, meta }) {
  const now = Date.now();
  const staleHours = staleHoursFor(manifest.code, now);
  const shift = currentShift(now);
  const alertData = {
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/1182181f-${manifest.code.toLowerCase()}-decode`,
    culprit: 'app/services/verticals/1182181f.js — decodeSamples',
    errorType: error.name,
    errorValue: error.message,
    devinUserId: meta.devinUserId,
    devinEmail: meta.devinEmail,
    devinOrgId: meta.devinOrgId,
    customer: '1182181f',
    service: SERVICE,
    verticalLabel: 'Talon Power Systems — Plant 07 Historian → MES Ingest',
    tags: [
      { key: 'route', value: '/api/1182181f/runs' },
      { key: 'service', value: SERVICE },
      { key: 'stage', value: stage },
      { key: 'line', value: manifest.code },
      { key: 'plant', value: PLANT.code },
      { key: 'protocol', value: manifest.protocol },
    ],
    extra: {
      requestId,
      runId: run.runId,
      lineCode: manifest.code,
      lineName: manifest.name,
      adapter: manifest.adapter,
      manifestVersion: manifest.manifestVersion,
      qualityEncoding: manifest.quality.encoding,
      stage,
      rowsIn,
      consecutiveFailures: consecutiveFailures[manifest.code],
      lastSuccessfulPublishAt: lastSuccessfulPublishes[manifest.code]
        ? new Date(lastSuccessfulPublishes[manifest.code]).toISOString() : null,
      currentShift: `${shift.label} (${shift.window} ${PLANT.timezone})`,
      promptContext: `${manifest.name} at ${PLANT.name} (${PLANT.code}) has published no OEE, counts or downtime to MES for ~${staleHours}h — every interval ingest since the ${manifest.adapter} cutover has failed at the ${stage} stage (${consecutiveFailures[manifest.code] || 0} consecutive). Supervisors are logging downtime on paper for ${shift.label} and the plant OEE rollup silently excludes the line.`,
    },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: new Date().toISOString(),
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || 'mes-ingest@4.11.2',
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
    promptAppendix: 'When you fix this, add regression tests that load every line manifest and assert its quality encoding and state model both resolve to a decoder, so the next adapter cutover cannot pass CI untested. Then record a browser video of the plant console showing Line 4 leaving NO DATA and the P07_MES_L4_Ingest_Stale alarm returning to normal.',
  };
  return createSessionAndAlert(alertData).catch((alertError) => {
    logger.error('Plant ingest alert attempt failed', {
      service: SERVICE,
      lineCode: manifest.code,
      runId: run.runId,
      error: alertError.message,
    });
    return null;
  });
}

async function runPipeline(lineCode, meta = {}) {
  const manifest = getLineManifest(lineCode);
  if (!manifest) throw new Error(`Unknown line ${lineCode}`);
  const requestId = uuidv4();
  const startedAt = Date.now();
  let stage = 'read_historian';
  let rowsIn = 0;
  const run = {
    runId: `job-${uuidv4().replace(/-/g, '').slice(0, 8)}`,
    lineCode,
    lineName: manifest.name,
    trigger: meta.trigger || 'manual',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: null,
    durationMs: null,
    stageReached: stage,
    status: 'failed',
    rowsIn: 0,
    rowsOut: 0,
    error: null,
  };
  logger.info('Starting historian interval ingest', { service: SERVICE, lineCode, runId: run.runId, stage });
  try {
    const read = readHistorian(manifest, Date.now());
    rowsIn = read.rowsIn;
    run.rowsIn = rowsIn;
    if (process.env.NODE_ENV !== 'test') {
      await new Promise((resolve) => setTimeout(resolve, 90 + Math.random() * 140));
    }
    stage = 'decode';
    run.stageReached = stage;
    const decoded = decodeSamples(manifest, read.rows);
    stage = 'aggregate_interval';
    run.stageReached = stage;
    const interval = aggregateInterval(manifest, decoded);
    stage = 'evaluate_alarms';
    run.stageReached = stage;
    const alarms = evaluateAlarms(manifest, interval);
    stage = 'publish';
    run.stageReached = stage;
    const published = publish(manifest, interval, alarms, run);
    incrementMetric('mes_ingest.interval.run', { line: lineCode, status: 'succeeded' });
    recordTiming('mes_ingest.interval.duration', published.durationMs, { line: lineCode, status: 'succeeded' });
    return published;
  } catch (error) {
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - startedAt;
    run.stageReached = stage;
    run.rowsIn = rowsIn;
    run.error = { name: error.name, message: error.message, stage };
    recordRun(run, { prepend: true });
    consecutiveFailures[lineCode] = (consecutiveFailures[lineCode] || 0) + 1;
    incrementMetric('mes_ingest.interval.run', { line: lineCode, status: 'failed' });
    recordTiming('mes_ingest.interval.duration', run.durationMs, { line: lineCode, status: 'failed' });
    Sentry.captureException(error, {
      tags: {
        service: SERVICE,
        line: lineCode,
        plant: PLANT.code,
        stage,
        alert_path: 'instant',
      },
    });
    const shouldAlert = run.trigger === 'manual'
      || (consecutiveFailures[lineCode] >= 3
        && (!lastAlerts[lineCode] || Date.now() - lastAlerts[lineCode] > ALERT_COOLDOWN_MS));
    if (shouldAlert) {
      const delivered = await sendAlert({ error, manifest, run, stage, requestId, rowsIn, meta });
      if (delivered) lastAlerts[lineCode] = Date.now();
    }
    return run;
  }
}

async function runAllLines(meta = {}) {
  const runs = [];
  for (const lineCode of Object.keys(LINE_MANIFESTS)) {
    runs.push(await runPipeline(lineCode, meta));
  }
  return runs;
}

function listRuns({ limit = 50, lineCode } = {}) {
  const parsedLimit = Number(limit);
  const count = Math.min(Math.max(parsedLimit > 0 ? parsedLimit : 50, 1), MAX_RUNS_PAGE);
  return RUNS
    .filter((run) => !lineCode || run.lineCode === lineCode)
    .slice()
    .sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt))
    .slice(0, count);
}

function acknowledgeAlarm(id, user) {
  const alarm = ALARMS.find((candidate) => candidate.id === id);
  if (!alarm) return null;
  if (alarm.state === 'ACTIVE_UNACK') alarm.state = 'ACTIVE_ACK';
  else if (alarm.state === 'RTN_UNACK') alarm.state = 'RTN_ACK';
  alarm.ackBy = user || 'operator';
  alarm.ackAt = new Date().toISOString();
  return alarm;
}

function tagPath(manifest, canonical, cellId) {
  const column = manifest.columns[canonical];
  if (manifest.protocol === 'opcua') {
    return cellId ? column.replace(`.${manifest.code}.`, `.${manifest.code}.${cellId}.`) : column;
  }
  if (manifest.protocol === 'mtconnect') {
    return `${PLANT.code}/${manifest.code}/${cellId ? `${cellId}/` : ''}${column}`;
  }
  return `[Kepware]${PLANT.code}.${manifest.code}.${cellId ? `${cellId}.` : ''}${column}`;
}

function browseTags(now) {
  const tags = [];
  Object.values(LINE_MANIFESTS).forEach((manifest) => {
    const line = LINES[manifest.code];
    const stale = now - new Date(line.lastPublishedAt).getTime() > STALE_AFTER_MS;
    const quality = stale ? 'STALE' : 'GOOD';
    const ts = line.lastPublishedAt;
    tags.push({ path: tagPath(manifest, 'rate'), lineCode: manifest.code, value: stale ? null : line.ratePerHr, eu: 'units/h', quality, timestamp: ts, dataType: 'REAL' });
    tags.push({ path: tagPath(manifest, 'goodCount'), lineCode: manifest.code, value: stale ? null : line.shiftGoodCount, eu: 'count', quality, timestamp: ts, dataType: 'DINT' });
    tags.push({ path: tagPath(manifest, 'rejectCount'), lineCode: manifest.code, value: stale ? null : line.shiftRejectCount, eu: 'count', quality, timestamp: ts, dataType: 'DINT' });
    Object.values(CELLS).filter((cell) => cell.lineCode === manifest.code).forEach((cell) => {
      tags.push({
        path: tagPath(manifest, 'state', cell.cellId),
        lineCode: manifest.code,
        cellId: cell.cellId,
        value: stale ? null : cell.stateRaw,
        display: stale ? null : cell.state,
        eu: manifest.stateModel === 'packml' ? 'enum' : 'string',
        quality: stale ? 'STALE' : cell.quality,
        timestamp: stale ? ts : cell.lastSampleAt,
        dataType: manifest.stateModel === 'packml' ? 'INT' : 'STRING',
      });
    });
  });
  return tags;
}

function deriveLineStatus(line, now) {
  const stale = now - new Date(line.lastPublishedAt).getTime() > STALE_AFTER_MS;
  if (stale) return { stale, status: 'NO DATA' };
  const cells = Object.values(CELLS).filter((cell) => cell.lineCode === line.code);
  const down = cells.filter((cell) => cell.category === 'down').length;
  const running = cells.filter((cell) => cell.category === 'running').length;
  if (running === 0) return { stale, status: 'DOWN' };
  if (down > 0 || running < cells.length) return { stale, status: 'DEGRADED' };
  return { stale, status: 'RUNNING' };
}

function getPlant(now = Date.now()) {
  const lines = Object.values(LINES).map((line) => {
    const derived = deriveLineStatus(line, now);
    const cells = Object.values(CELLS).filter((cell) => cell.lineCode === line.code);
    return {
      ...line,
      ...derived,
      cellCount: cells.length,
      runningCells: cells.filter((cell) => cell.category === 'running').length,
      consecutiveFailures: consecutiveFailures[line.code] || 0,
      activeAlarms: ALARMS.filter((alarm) => alarm.lineCode === line.code && alarm.state.startsWith('ACTIVE')).length,
    };
  });
  const reporting = lines.filter((line) => !line.stale);
  const plantOee = reporting.length
    ? round(reporting.reduce((sum, line) => sum + line.oee, 0) / reporting.length, 3) : null;
  const dayAgo = now - 24 * 60 * 60 * 1000;
  const priorities = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
  ALARMS.filter((alarm) => alarm.state.startsWith('ACTIVE')).forEach((alarm) => { priorities[alarm.priority] += 1; });
  return {
    plant: PLANT,
    shift: currentShift(now),
    intervalMinutes: INTERVAL_MIN,
    staleAfterMs: STALE_AFTER_MS,
    generatedAt: new Date(now).toISOString(),
    lines,
    cells: Object.values(CELLS),
    alarms: ALARMS.slice().sort((a, b) => {
      const order = { CRITICAL: 0, HIGH: 1, MEDIUM: 2, LOW: 3 };
      const active = Number(b.state.startsWith('ACTIVE')) - Number(a.state.startsWith('ACTIVE'));
      return active || order[a.priority] - order[b.priority] || new Date(b.activeAt) - new Date(a.activeAt);
    }),
    tags: browseTags(now),
    summary: {
      lineCount: lines.length,
      linesReporting: reporting.length,
      staleLines: lines.filter((line) => line.stale).map((line) => line.code),
      plantOee,
      availability: reporting.length ? round(reporting.reduce((sum, line) => sum + line.availability, 0) / reporting.length, 3) : null,
      performance: reporting.length ? round(reporting.reduce((sum, line) => sum + line.performance, 0) / reporting.length, 3) : null,
      quality: reporting.length ? round(reporting.reduce((sum, line) => sum + line.quality, 0) / reporting.length, 3) : null,
      activeAlarms: priorities,
      unackedAlarms: ALARMS.filter((alarm) => alarm.state.endsWith('_UNACK')).length,
      failedRunsLast24h: failureTimestamps.filter((timestamp) => timestamp >= dayAgo && timestamp <= now).length,
      lastRunAt: RUNS.length ? listRuns({ limit: 1 })[0].startedAt : null,
    },
  };
}

function getLine(code, now = Date.now()) {
  const line = LINES[code];
  if (!line) return null;
  const manifest = getLineManifest(code);
  return {
    line: { ...line, ...deriveLineStatus(line, now) },
    manifest,
    cells: Object.values(CELLS).filter((cell) => cell.lineCode === code),
    alarms: ALARMS.filter((alarm) => alarm.lineCode === code),
    runs: listRuns({ lineCode: code, limit: 20 }),
  };
}

function startScheduler(intervalMs = Number(process.env.X1182181F_RUN_INTERVAL_MS) || INTERVAL_MIN * 60 * 1000) {
  stopScheduler();
  schedulerHandle = setInterval(() => {
    runAllLines({ trigger: 'scheduled' }).catch((error) => {
      logger.error('Plant ingest scheduler failed', { service: SERVICE, error: error.message });
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
  runAllLines,
  listRuns,
  getPlant,
  getLine,
  acknowledgeAlarm,
  resetStore: seedStore,
  startScheduler,
  stopScheduler,
  getLineManifest,
  STAGES,
  LINES,
  CELLS,
  ALARMS,
  RUNS,
};
