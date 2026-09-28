const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { DEALER_DISTRICT, districtFor } = require('./a70e8270-dealer-mapping');

const SERVICE = 'a70e8270-api';
const RELEASE = process.env.SENTRY_RELEASE || 'dealer-service-dw@3.4.0';
const SLACK_MEMBER_ID = 'U0BDHHQUM24';

const SCHEDULER = {
  name: 'Tidal Automation',
  group: 'DEALER_SERVICE_DW',
  agent: 'TIDAL-AGT-DW02',
  timezone: 'America/Chicago',
};

const JOB_OWNER = 'dealer-service-dw@devindemos.com';
const SEEDED_RUNS = 6;

const DISTRICTS = [
  { code: 'C-11', name: 'North Central' },
  { code: 'C-12', name: 'Great Lakes' },
  { code: 'C-13', name: 'Gulf Coast' },
  { code: 'C-14', name: 'Mountain West' },
  { code: 'C-15', name: 'Southeast' },
  { code: 'C-16', name: 'Mid-Atlantic' },
  { code: 'C-17', name: 'Pacific Northwest' },
  { code: 'C-18', name: 'Southwest' },
];

const DEALER_NAMES = [
  'Gulf Coast Equipment Co',
  'Blue Ridge Power & Machinery',
  'Cascade Iron Works',
  'High Plains Equipment',
  'Tidewater Machinery',
  'Red River Tractor & Equipment',
  'Great Lakes Machinery Co',
  'Sierra Crest Equipment',
  'Lone Star Heavy Equipment',
  'Bayou Industrial Supply',
  'Ohio Valley Equipment',
  'Piedmont Machinery',
  'Black Hills Equipment Co',
  'Intermountain Tractor',
  'Delta Machinery',
  'Copper State Equipment',
  'Prairie State Machinery',
  'Prairie State Machinery — Quad Cities',
  'Prairie State Machinery — Central Illinois',
  'Coastal Carolina Machinery',
  'Badger State Equipment',
  'Wasatch Front Machinery',
  'Sunbelt Power Systems',
  'Northwoods Equipment',
  'Mesa Verde Machinery',
  'Heartland Equipment Co',
  'Cumberland Machinery',
  'Puget Sound Equipment',
  'Front Range Machinery',
  'Palmetto Equipment Co',
  'Bluegrass Machinery',
  'Big Sky Equipment',
  'Alamo Heavy Equipment',
  'Tri-State Tractor',
  'Rio Grande Machinery',
  'Chesapeake Equipment',
  'Rocky Mountain Iron',
  'Ozark Equipment Co',
  'Sandhills Machinery',
  'Yellowstone Equipment Co',
];

const MACHINE_MODELS = [
  { model: '320', weight: 0.30 },
  { model: '336', weight: 0.25 },
  { model: 'D6', weight: 0.15 },
  { model: '745', weight: 0.10 },
  { model: '966M', weight: 0.10 },
  { model: '994K', weight: 0.10 },
];

const SERIAL_PREFIXES = ['HEX', 'TFS', 'LGX', 'RAB', 'PBM', 'WBS'];
const ALNUM = 'ABCDEFGHJKLMNPQRSTUVWXYZ0123456789';

const FACT_WORK_ORDER = {
  table: 'ANALYTICS.FACT_WORK_ORDER',
  columns: {
    WORK_ORDER_NO: { type: 'VARCHAR(16)', nullable: false },
    MACHINE_PIN: { type: 'VARCHAR(17)', nullable: false },
    DEALER_CD: { type: 'VARCHAR(8)', nullable: false },
    DISTRICT_CD: { type: 'VARCHAR(8)', nullable: false },
    SMU_HRS: { type: 'NUMBER(10,1)', nullable: true },
    SMU_DELTA_HRS: { type: 'NUMBER(10,1)', nullable: true },
    OPEN_DT: { type: 'DATE', nullable: true },
    CLOSE_DT: { type: 'DATE', nullable: true },
    LABOR_HRS: { type: 'NUMBER(6,1)', nullable: true },
    PARTS_COST: { type: 'NUMBER(12,2)', nullable: true },
    CVA_FLAG: { type: 'BOOLEAN', nullable: true },
    LOAD_BATCH_ID: { type: 'VARCHAR(24)', nullable: false },
  },
};

const WORK_ORDERS_BACKLOG = 5012;

function sourceTables() {
  return [
    { name: 'dbo.work_orders', rows: WORK_ORDERS_BACKLOG + RUNS.reduce((sum, run) => sum + run.rowsExtracted, 0) },
    { name: 'dbo.machines', rows: MACHINES.length },
    { name: 'dbo.dealers', rows: DEALERS.length },
  ];
}

class IntegrityError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'IntegrityError';
    this.code = 100072;
    this.sqlState = '22004';
  }
}

let RUNS = [];
let JOBS = [];
let WAREHOUSE_TABLES = [];
let DEALERS = [];
let MACHINES = [];
let MACHINE_SMU = {};
let dwState = {};
let nextBatchNo = 1;
let generation = 0;

function createRandom(seed) {
  let t = seed >>> 0;
  return function next() {
    t += 0x6D2B79F5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function isoDate(d) {
  return d.toISOString().slice(0, 10);
}

function ctDateString(d) {
  return d.toLocaleDateString('en-CA', { timeZone: SCHEDULER.timezone });
}

function lastSaturday(now) {
  const d = new Date(now.getTime());
  d.setHours(0, 0, 0, 0);
  const day = d.getDay();
  const back = (day + 1) % 7 || 7;
  d.setDate(d.getDate() - back);
  return isoDate(d);
}

function dateForCtTime(base, hh, mm) {
  const ct = new Date(base.toLocaleString('en-US', { timeZone: SCHEDULER.timezone }));
  ct.setHours(hh, mm, 0, 0);
  const offset = base.getTime() - new Date(base.toLocaleString('en-US', { timeZone: SCHEDULER.timezone })).getTime();
  return new Date(ct.getTime() + offset);
}

const DAY_MS = 24 * 60 * 60 * 1000;

function nextCtOccurrence(now, hh, mm) {
  const candidate = dateForCtTime(now, hh, mm);
  return candidate.getTime() > now.getTime() ? candidate : new Date(candidate.getTime() + DAY_MS);
}

function pickModel(random) {
  let roll = random();
  for (const entry of MACHINE_MODELS) {
    if (roll < entry.weight) return entry.model;
    roll -= entry.weight;
  }
  return MACHINE_MODELS[0].model;
}

function randomAlnum(random, len) {
  let out = '';
  for (let i = 0; i < len; i += 1) out += ALNUM[Math.floor(random() * ALNUM.length)];
  return out;
}

function buildMachine(random, dealerCd) {
  const model = pickModel(random);
  const pin = `CAT${model.padEnd(4, '0').slice(0, 4)}${randomAlnum(random, 10)}`;
  const inServiceYear = 2008 + Math.floor(random() * 15);
  const inServiceDt = `${inServiceYear}-${String(1 + Math.floor(random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(random() * 28)).padStart(2, '0')}`;
  return {
    machinePin: pin,
    model,
    serialPrefix: SERIAL_PREFIXES[Math.floor(random() * SERIAL_PREFIXES.length)],
    dealerCd,
    inServiceDt,
    smuHrs: Number((400 + random() * 18600).toFixed(1)),
  };
}

function seedDealersAndMachines(now) {
  const random = createRandom(20240229);
  const splitDt = lastSaturday(now);
  DEALERS = DEALER_NAMES.map((dealerName, i) => {
    const dealerCd = `D-${4401 + i}`;
    const isSplit = dealerCd === 'D-4418' || dealerCd === 'D-4419';
    const isParent = dealerCd === 'D-4417';
    const districtCd = isSplit || isParent ? 'C-11' : DEALER_DISTRICT[dealerCd];
    const activeYear = 2009 + Math.floor(random() * 13);
    const activeDt = isSplit
      ? splitDt
      : `${activeYear}-${String(1 + Math.floor(random() * 12)).padStart(2, '0')}-${String(1 + Math.floor(random() * 28)).padStart(2, '0')}`;
    return {
      dealerCd,
      dealerName,
      districtCd,
      activeDt,
      machines: 0,
      openWorkOrders: 3 + Math.floor(random() * 38),
      closedLast24h: 0,
      territorySplit: isSplit ? { from: 'D-4417', changeTicket: 'TERR-2291' } : null,
    };
  });
  MACHINES = [];
  MACHINE_SMU = {};
  DEALERS.forEach((dealer) => {
    const count = 40 + Math.floor(random() * 18);
    dealer.machines = count;
    for (let i = 0; i < count; i += 1) {
      MACHINES.push(buildMachine(random, dealer.dealerCd));
    }
  });
}

function machinesByModel() {
  const byModel = {};
  MACHINES.forEach((machine) => {
    if (!byModel[machine.model]) byModel[machine.model] = { model: machine.model, count: 0, smuTotal: 0 };
    byModel[machine.model].count += 1;
    byModel[machine.model].smuTotal += machine.smuHrs;
  });
  return Object.values(byModel).map((entry) => ({
    model: entry.model,
    count: entry.count,
    avgSmuHrs: Number((entry.smuTotal / entry.count).toFixed(1)),
  }));
}

function buildBatch(batchNo, windowEnd, scheduledAt = windowEnd) {
  const random = createRandom(batchNo * 7919 + 17);
  const rowCount = 180 + Math.floor(random() * 31);
  const windowMs = DAY_MS;
  const windowStart = new Date(windowEnd.getTime() - windowMs);
  const machinesByDealer = {};
  MACHINES.forEach((machine) => {
    if (!machinesByDealer[machine.dealerCd]) machinesByDealer[machine.dealerCd] = [];
    machinesByDealer[machine.dealerCd].push(machine);
  });
  const isNewTerritoryBatch = batchNo > SEEDED_RUNS;
  const activeDealers = DEALERS.filter((dealer) => dealer.activeDt <= isoDate(windowEnd) && !dealer.territorySplit);
  const rows = [];
  const splitCount = isNewTerritoryBatch ? 5 + Math.floor(random() * 5) : 0;
  const splitPositions = new Set();
  for (let k = 0; k < splitCount; k += 1) {
    splitPositions.add(Math.min(rowCount - 1, Math.floor(((k + 0.5) * rowCount) / splitCount + (random() - 0.5) * 8)));
  }
  for (let i = 0; i < rowCount; i += 1) {
    let dealer;
    if (splitPositions.has(i)) {
      dealer = DEALERS[17 + (i % 2)];
    } else {
      dealer = activeDealers[Math.floor(random() * activeDealers.length)];
    }
    const pool = machinesByDealer[dealer.dealerCd];
    const machine = pool[Math.floor(random() * pool.length)];
    const lastSmu = MACHINE_SMU[machine.machinePin] !== undefined ? MACHINE_SMU[machine.machinePin] : machine.smuHrs;
    const smuHrs = Number((lastSmu + random() * 42).toFixed(1));
    const closeDt = new Date(windowStart.getTime() + random() * windowMs);
    const openDt = new Date(closeDt.getTime() - (1 + Math.floor(random() * 9)) * 24 * 60 * 60 * 1000);
    rows.push({
      workOrderNo: `WO-2609-${String(4000 + batchNo * 211 + i).padStart(5, '0')}`,
      machinePin: machine.machinePin,
      model: machine.model,
      dealerCd: dealer.dealerCd,
      smuHrs,
      openDt: isoDate(openDt),
      closeDt: isoDate(closeDt),
      laborHrs: Number((0.5 + random() * 11.5).toFixed(1)),
      partsCost: Number((random() * 4800).toFixed(2)),
      cvaFlag: random() < 0.55,
    });
  }
  return {
    batchNo,
    batchId: `SMU_WO_${ctDateString(scheduledAt).replace(/-/g, '')}_0215`,
    jobName: 'SMU_WORKORDER_DAILY_LOAD',
    windowStart: windowStart.toISOString(),
    windowEnd: windowEnd.toISOString(),
    rows,
  };
}

function extractClosedWorkOrders(batch) {
  return batch.rows;
}

function computeSmuDelta(row) {
  const last = MACHINE_SMU[row.machinePin];
  const base = last === undefined ? 0 : last;
  return Number((row.smuHrs - base).toFixed(1));
}

function transformRow(row, batch) {
  return {
    ...row,
    districtCd: districtFor(row.dealerCd),
    smuDeltaHrs: computeSmuDelta(row),
    loadBatchId: batch.batchId,
  };
}

function columnToField(columnName) {
  return columnName.toLowerCase().replace(/_([a-z])/g, (_m, ch) => ch.toUpperCase());
}

function bindRow(row, columns, table) {
  const bound = {};
  Object.entries(columns).forEach(([columnName, def]) => {
    const field = columnToField(columnName);
    const value = row[field];
    if (def.nullable === false && (value === null || value === undefined)) {
      throw new IntegrityError(`NULL result in a non-nullable column: ${table}.${columnName}`);
    }
    bound[columnName] = value;
  });
  return bound;
}

function loadFactWorkOrder(rows, batch, run, loadedAt = new Date().toISOString()) {
  const boundRows = [];
  for (let i = 0; i < rows.length; i += 1) {
    try {
      boundRows.push(bindRow(rows[i], FACT_WORK_ORDER.columns, FACT_WORK_ORDER.table));
    } catch (error) {
      error.rowsBound = i;
      throw error;
    }
  }
  const machinePins = new Set();
  rows.forEach((row) => {
    MACHINE_SMU[row.machinePin] = row.smuHrs;
    machinePins.add(row.machinePin);
  });
  const table = WAREHOUSE_TABLES.find((t) => t.name === FACT_WORK_ORDER.table);
  if (table) {
    table.rows += boundRows.length;
    table.lastLoadAt = loadedAt;
    table.status = 'Current';
  }
  if (run) {
    run.rowsLoaded = boundRows.length;
    run.machinesUpdated = machinePins.size;
  }
  return { rowsLoaded: boundRows.length, machinesUpdated: machinePins.size, loadedAt };
}

function pendingWindowEnd() {
  return new Date();
}

function pendingBatch() {
  const windowEnd = pendingWindowEnd();
  return buildBatch(nextBatchNo, windowEnd, nextCtOccurrence(windowEnd, 2, 15));
}

function currentSummary() {
  const pending = pendingBatch();
  return {
    status: dwState.status,
    lastSuccessfulLoadAt: dwState.lastSuccessfulLoadAt,
    lastBatchId: dwState.lastBatchId,
    rowsLoadedLastRun: dwState.rowsLoadedLastRun,
    rowsLoadedWeek: dwState.rowsLoadedWeek,
    failedBatches: dwState.failedBatches,
    lastError: dwState.lastError,
    lastFailureAt: dwState.lastFailureAt,
    pendingBatch: {
      batchNo: pending.batchNo,
      batchId: pending.batchId,
      rowCount: pending.rows.length,
      windowStart: pending.windowStart,
      windowEnd: pending.windowEnd,
    },
    blockedJobs: JOBS.filter((job) => job.status === 'blocked').map((job) => job.jobName),
  };
}

function markDegraded(batch, error, run, failedAt) {
  dwState.status = 'degraded';
  dwState.failedBatches += 1;
  dwState.lastFailureAt = failedAt;
  dwState.lastError = {
    errorClass: error.name,
    message: error.message,
    code: error.code,
    sqlState: error.sqlState,
    batchId: batch.batchId,
    stage: run.stage,
    rowsExtracted: run.rowsExtracted,
    targetTable: FACT_WORK_ORDER.table,
  };
  const blockedNames = new Set([batch.jobName]);
  let grew = true;
  while (grew) {
    grew = false;
    JOBS.forEach((job) => {
      if (job.dependsOn && blockedNames.has(job.dependsOn) && !blockedNames.has(job.jobName)) {
        blockedNames.add(job.jobName);
        grew = true;
      }
    });
  }
  JOBS.forEach((job) => {
    if (job.jobName === batch.jobName) {
      job.status = 'failed';
      job.lastRunAt = failedAt;
      job.nextRunAt = null;
    } else if (blockedNames.has(job.jobName)) {
      job.status = 'blocked';
      job.blockedBy = batch.jobName;
    }
  });
  WAREHOUSE_TABLES.forEach((table) => {
    if (table.feed === 'CVA_COVERAGE_REFRESH' || table.feed === 'PARTS_DEMAND_FORECAST') {
      table.status = 'Stale';
    }
  });
}

function markHealthy(run) {
  dwState.status = 'healthy';
  dwState.lastError = null;
  const now = new Date();
  JOBS.forEach((job) => {
    if (job.status === 'blocked') {
      job.status = 'success';
      job.blockedBy = null;
      job.lastRunAt = run.finishedAt;
    }
    const match = job.schedule.match(/^(\d{2}):(\d{2})/);
    if (match) {
      job.nextRunAt = nextCtOccurrence(now, Number(match[1]), Number(match[2])).toISOString();
    }
  });
  WAREHOUSE_TABLES.forEach((table) => {
    if (table.feed === 'CVA_COVERAGE_REFRESH' || table.feed === 'PARTS_DEMAND_FORECAST') {
      table.status = 'Current';
      table.lastLoadAt = run.finishedAt;
    }
  });
}

function alertData(error, batch, run, meta, counts) {
  return {
    issueTitle: `${error.name}: ${error.message}`,
    issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/a70e8270-dw-load-${batch.batchNo}`,
    culprit: 'app/services/verticals/a70e8270.js — loadFactWorkOrder',
    errorType: error.name || 'Error',
    errorValue: error.message,
    devinUserId: meta.devinUserId,
    devinEmail: meta.devinEmail,
    devinOrgId: meta.devinOrgId,
    slackMemberId: SLACK_MEMBER_ID,
    slackMemberIdFallback: SLACK_MEMBER_ID,
    service: SERVICE,
    verticalLabel: 'Dealer Service DW — SMU_WORKORDER_DAILY_LOAD (work orders → analytics.fact_work_order)',
    tags: [
      { key: 'route', value: '/api/a70e8270/load/run' },
      { key: 'service', value: SERVICE },
      { key: 'component', value: 'smu-workorder-daily-load' },
      { key: 'job', value: batch.jobName },
      { key: 'batch', value: batch.batchId },
      { key: 'stage', value: run.stage },
      { key: 'scheduler', value: 'tidal' },
    ],
    extra: {
      requestId: run.requestId,
      jobName: batch.jobName,
      batchId: batch.batchId,
      window: { start: batch.windowStart, end: batch.windowEnd },
      rowsExtracted: counts.rowsExtracted,
      rowsTransformed: counts.rowsTransformed,
      rowsLoaded: 0,
      failingRowIndex: error.rowsBound,
      targetTable: FACT_WORK_ORDER.table,
      downstreamBlocked: ['CVA_COVERAGE_REFRESH', 'PARTS_DEMAND_FORECAST'],
      sqlState: error.sqlState,
      code: error.code,
      replayEndpoint: 'POST /api/a70e8270/load/run',
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
    triggeredRule: 'Tidal job SMU_WORKORDER_DAILY_LOAD exited non-zero (rc=1); Datadog monitor dw.job.failed > 0 (group DEALER_SERVICE_DW)',
    promptAppendix: [
      '## Incident context',
      `- The nightly Tidal job SMU_WORKORDER_DAILY_LOAD (group DEALER_SERVICE_DW) failed while loading ${batch.batchId} into ANALYTICS.FACT_WORK_ORDER: ${counts.rowsExtracted} closed work orders from the 24h window ${batch.windowStart} → ${batch.windowEnd} were rolled back; nothing from tonight's batch reached the warehouse.`,
      '- Downstream jobs CVA_COVERAGE_REFRESH and PARTS_DEMAND_FORECAST are blocked on this dependency, so CVA coverage reporting and the parts demand signal are stale this morning.',
      `- Error: IntegrityError 100072 (22004) NULL result in a non-nullable column: ANALYTICS.FACT_WORK_ORDER.DISTRICT_CD. The failing row index within the batch is ${error.rowsBound}. DEALER_DIM_SYNC (dbo.dealers → analytics.dim_dealer) completed normally at 01:30 CT.`,
      '',
      '## Remediation expectations',
      '- Find which rows produced a null DISTRICT_CD and why; do not stop at the symptom.',
      '- Fix the pipeline so the dealer → district lookup reflects the dealer dimension (which is loaded nightly) rather than drifting from it, so newly activated dealer codes load correctly.',
      '- Rows that still cannot be resolved must be quarantined to a reject table (e.g. ANALYTICS.FACT_WORK_ORDER_REJECTS with the reject reason and batch id) and reported — never silently dropped, and one bad row must not roll back the whole batch.',
      '- Add a unit test covering a newly activated dealer code and a quarantined row.',
      '- Re-run the batch via `POST /api/a70e8270/load/run` and confirm rows loaded > 0 and the two downstream jobs unblock.',
      '- Post a plain-language summary in the PR description — a human approves every change; do not merge.',
    ].join('\n'),
  };
}

async function runDailyLoad(meta = {}) {
  const gen = generation;
  const batch = pendingBatch();
  const requestId = uuidv4();
  const startedAt = new Date();
  const run = {
    runId: `run-${requestId.slice(0, 8)}`,
    requestId,
    jobName: batch.jobName,
    batchId: batch.batchId,
    batchNo: batch.batchNo,
    trigger: meta.trigger || 'manual',
    windowStart: batch.windowStart,
    windowEnd: batch.windowEnd,
    startedAt: startedAt.toISOString(),
    finishedAt: null,
    durationMs: null,
    status: 'running',
    stage: 'extract',
    rowsExtracted: 0,
    rowsTransformed: 0,
    rowsLoaded: 0,
    machinesUpdated: 0,
    error: null,
  };
  RUNS.unshift(run);
  if (RUNS.length > 60) RUNS.pop();

  logger.info('SMU_WORKORDER_DAILY_LOAD started', {
    requestId,
    jobName: batch.jobName,
    batchId: batch.batchId,
    trigger: run.trigger,
    windowStart: batch.windowStart,
    windowEnd: batch.windowEnd,
    release: RELEASE,
    service: SERVICE,
  });
  const metricTags = [`job:${batch.jobName}`, `scheduler:tidal`, `trigger:${run.trigger}`, `release:${RELEASE}`];
  incrementMetric('dw.job.started', metricTags);

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    if (gen !== generation) {
      const stale = new Error('Console reset during run');
      stale.discarded = true;
      throw stale;
    }

    run.stage = 'extract';
    const extracted = extractClosedWorkOrders(batch);
    run.rowsExtracted = extracted.length;
    run.stage = 'transform';
    const transformed = extracted.map((row) => transformRow(row, batch));
    run.rowsTransformed = transformed.length;
    run.stage = 'load';
    const { rowsLoaded } = loadFactWorkOrder(transformed, batch, run);

    nextBatchNo += 1;
    run.status = 'succeeded';
    run.stage = 'done';
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - startedAt.getTime();
    dwState.lastSuccessfulLoadAt = run.finishedAt;
    dwState.lastBatchId = batch.batchId;
    dwState.rowsLoadedLastRun = rowsLoaded;
    dwState.rowsLoadedWeek += rowsLoaded;
    JOBS.forEach((job) => {
      if (job.jobName === batch.jobName) {
        job.status = 'success';
        job.lastRunAt = run.finishedAt;
        job.lastDurationMs = run.durationMs;
      }
    });
    markHealthy(run);
    incrementMetric('dw.job.succeeded', metricTags);
    recordMetric('dw.fact_work_order.rows_loaded', rowsLoaded, metricTags);
    recordTiming('dw.job.duration', run.durationMs, metricTags);
    logger.info('SMU_WORKORDER_DAILY_LOAD committed', {
      requestId,
      jobName: batch.jobName,
      batchId: batch.batchId,
      rowsLoaded,
      durationMs: run.durationMs,
      service: SERVICE,
    });
    return { run, summary: currentSummary() };
  } catch (error) {
    if (error.discarded) {
      run.status = 'discarded';
      run.finishedAt = new Date().toISOString();
      run.durationMs = Date.now() - startedAt.getTime();
      logger.warn('SMU_WORKORDER_DAILY_LOAD result discarded — console was reset mid-run', {
        requestId,
        jobName: batch.jobName,
        batchId: batch.batchId,
        service: SERVICE,
      });
      throw error;
    }
    run.status = 'failed';
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.now() - startedAt.getTime();
    run.error = { type: error.name, message: error.message, stage: run.stage };
    dwState.lastBatchId = batch.batchId;
    dwState.rowsLoadedLastRun = 0;
    markDegraded(batch, error, run, run.finishedAt);

    incrementMetric('dw.job.failed', [...metricTags, `error_type:${error.name}`, `stage:${run.stage}`]);
    recordTiming('dw.job.duration', run.durationMs, metricTags);
    logger.error('SMU_WORKORDER_DAILY_LOAD failed — batch rolled back', {
      requestId,
      jobName: batch.jobName,
      batchId: batch.batchId,
      stage: run.stage,
      rowsExtracted: run.rowsExtracted,
      rowsBound: error.rowsBound,
      targetTable: FACT_WORK_ORDER.table,
      error: error.message,
      errorClass: error.name,
      sqlState: error.sqlState,
      code: error.code,
      stack: error.stack,
      service: SERVICE,
    });

    Sentry.withScope((scope) => {
      scope.setTag('route', '/api/a70e8270/load/run');
      scope.setTag('service', SERVICE);
      scope.setTag('alert_path', 'instant');
      scope.setTag('component', 'smu-workorder-daily-load');
      scope.setTag('job', batch.jobName);
      scope.setTag('batch', batch.batchId);
      scope.setTag('stage', run.stage);
      scope.setContext('batch', {
        batchId: batch.batchId,
        jobName: batch.jobName,
        windowStart: batch.windowStart,
        windowEnd: batch.windowEnd,
        rowsExtracted: run.rowsExtracted,
      });
      Sentry.captureException(error);
    });

    createSessionAndAlert(alertData(error, batch, run, meta, {
      rowsExtracted: run.rowsExtracted,
      rowsTransformed: run.rowsTransformed,
    })).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, service: SERVICE });
    });
    throw error;
  }
}

function seedJobs(now) {
  const tonight = (h, m) => nextCtOccurrence(now, h, m);
  const lastRun = (h, m) => new Date(tonight(h, m).getTime() - DAY_MS);
  const lastNight0215 = lastRun(2, 15);
  const lastNight0300 = lastRun(3, 0);
  const lastNight0330 = lastRun(3, 30);
  JOBS = [
    {
      jobName: 'DEALER_DIM_SYNC',
      description: 'dbo.dealers → ANALYTICS.DIM_DEALER',
      schedule: '01:30 CT daily',
      dependsOn: null,
      blockedBy: null,
      status: 'success',
      lastRunAt: lastRun(1, 30).toISOString(),
      nextRunAt: tonight(1, 30).toISOString(),
      lastDurationMs: 8400,
      owner: JOB_OWNER,
      agent: SCHEDULER.agent,
    },
    {
      jobName: 'SMU_WORKORDER_DAILY_LOAD',
      description: 'closed work orders → district, SMU delta → ANALYTICS.FACT_WORK_ORDER',
      schedule: '02:15 CT daily',
      dependsOn: 'DEALER_DIM_SYNC',
      blockedBy: null,
      status: 'ready',
      lastRunAt: lastNight0215.toISOString(),
      nextRunAt: tonight(2, 15).toISOString(),
      lastDurationMs: 52000,
      owner: JOB_OWNER,
      agent: SCHEDULER.agent,
    },
    {
      jobName: 'CVA_COVERAGE_REFRESH',
      description: 'refresh ANALYTICS.CVA_COVERAGE',
      schedule: '03:00 CT daily',
      dependsOn: 'SMU_WORKORDER_DAILY_LOAD',
      blockedBy: null,
      status: 'success',
      lastRunAt: lastNight0300.toISOString(),
      nextRunAt: tonight(3, 0).toISOString(),
      lastDurationMs: 31000,
      owner: JOB_OWNER,
      agent: SCHEDULER.agent,
    },
    {
      jobName: 'PARTS_DEMAND_FORECAST',
      description: 'refresh ANALYTICS.PARTS_DEMAND_FORECAST',
      schedule: '03:30 CT daily',
      dependsOn: 'CVA_COVERAGE_REFRESH',
      blockedBy: null,
      status: 'success',
      lastRunAt: lastNight0330.toISOString(),
      nextRunAt: tonight(3, 30).toISOString(),
      lastDurationMs: 46000,
      owner: JOB_OWNER,
      agent: SCHEDULER.agent,
    },
  ];
  WAREHOUSE_TABLES = [
    {
      name: 'ANALYTICS.FACT_WORK_ORDER',
      rows: 1216400,
      lastLoadAt: lastNight0215.toISOString(),
      status: 'Current',
      feed: 'SMU_WORKORDER_DAILY_LOAD',
    },
    {
      name: 'ANALYTICS.DIM_DEALER',
      rows: 40,
      lastLoadAt: lastRun(1, 30).toISOString(),
      status: 'Current',
      feed: 'DEALER_DIM_SYNC',
    },
    {
      name: 'ANALYTICS.CVA_COVERAGE',
      rows: 48213,
      lastLoadAt: lastNight0300.toISOString(),
      status: 'Current',
      feed: 'CVA_COVERAGE_REFRESH',
    },
    {
      name: 'ANALYTICS.PARTS_DEMAND_FORECAST',
      rows: 212540,
      lastLoadAt: lastNight0330.toISOString(),
      status: 'Current',
      feed: 'PARTS_DEMAND_FORECAST',
    },
  ];
}

function seedStore() {
  const now = new Date();
  generation += 1;
  RUNS = [];
  nextBatchNo = 1;
  seedDealersAndMachines(now);
  seedJobs(now);
  dwState = {
    status: 'healthy',
    lastSuccessfulLoadAt: null,
    lastBatchId: null,
    rowsLoadedLastRun: 0,
    rowsLoadedWeek: 0,
    failedBatches: 0,
    lastError: null,
    lastFailureAt: null,
  };

  for (let i = 1; i <= SEEDED_RUNS; i += 1) {
    const windowEnd = new Date(nextCtOccurrence(now, 2, 15).getTime() - (SEEDED_RUNS - i + 1) * DAY_MS);
    const batch = buildBatch(i, windowEnd);
    const extracted = extractClosedWorkOrders(batch);
    const transformed = extracted.map((row) => transformRow(row, batch));
    const durationMs = 40000 + Math.floor(createRandom(i * 331 + 5)() * 30000);
    const run = {
      runId: `run-seed-${String(i).padStart(4, '0')}`,
      requestId: uuidv4(),
      jobName: batch.jobName,
      batchId: batch.batchId,
      batchNo: i,
      trigger: 'scheduled',
      windowStart: batch.windowStart,
      windowEnd: batch.windowEnd,
      startedAt: windowEnd.toISOString(),
      finishedAt: new Date(windowEnd.getTime() + durationMs).toISOString(),
      durationMs,
      status: 'succeeded',
      stage: 'done',
      rowsExtracted: extracted.length,
      rowsTransformed: transformed.length,
      rowsLoaded: 0,
      machinesUpdated: 0,
      error: null,
    };
    const { rowsLoaded } = loadFactWorkOrder(transformed, batch, run, run.finishedAt);
    dwState.lastSuccessfulLoadAt = run.finishedAt;
    dwState.lastBatchId = batch.batchId;
    dwState.rowsLoadedLastRun = rowsLoaded;
    dwState.rowsLoadedWeek += rowsLoaded;
    RUNS.unshift(run);
    nextBatchNo = i + 1;
  }
  const pending = pendingBatch();
  const closedByDealer = {};
  pending.rows.forEach((row) => {
    closedByDealer[row.dealerCd] = (closedByDealer[row.dealerCd] || 0) + 1;
  });
  DEALERS.forEach((dealer) => {
    dealer.closedLast24h = closedByDealer[dealer.dealerCd] || 0;
  });
  logger.info('Dealer service DW store seeded', { runs: RUNS.length, dealers: DEALERS.length, machines: MACHINES.length, service: SERVICE });
}

function getOverview() {
  const pending = pendingBatch();
  const closedByDealer = {};
  pending.rows.forEach((row) => {
    closedByDealer[row.dealerCd] = (closedByDealer[row.dealerCd] || 0) + 1;
  });
  const dealers = DEALERS.map((dealer) => ({ ...dealer, closedLast24h: closedByDealer[dealer.dealerCd] || 0 }));
  return {
    service: SERVICE,
    release: RELEASE,
    scheduler: SCHEDULER,
    summary: currentSummary(),
    jobs: JOBS,
    source: { system: 'SQL Server — DSMS', tables: sourceTables() },
    warehouse: { system: 'Snowflake — CAT_ANALYTICS', tables: WAREHOUSE_TABLES },
    districts: DISTRICTS,
    dealers,
    machinesByModel: machinesByModel(),
    runs: RUNS,
    previewRows: pending.rows.slice(0, 12),
  };
}

function listRuns() {
  return RUNS;
}

function resetLoad() {
  const cleared = { runs: RUNS.length, failed: dwState.failedBatches };
  seedStore();
  logger.info('Dealer service DW demo state reset', { ...cleared, service: SERVICE });
  incrementMetric('dw.demo.reset', ['scheduler:tidal']);
  return { success: true, cleared, summary: currentSummary() };
}

seedStore();

module.exports = {
  runDailyLoad,
  resetLoad,
  getOverview,
  listRuns,
  buildBatch,
  transformRow,
  loadFactWorkOrder,
  IntegrityError,
  FACT_WORK_ORDER,
  DISTRICTS,
  DEALERS,
};
