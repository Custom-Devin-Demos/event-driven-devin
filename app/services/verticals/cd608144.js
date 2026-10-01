const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const {
  PROTOCOLS,
  EF_VIEW_WEIGHTS,
  viewKey,
  efViews,
  describeView,
} = require('./cd608144-view-protocols');

const SERVICE = 'cd608144-api';
const ROUTE = '/api/cd608144/process';
const PIPELINE_VERSION = '2.7.1';
const QUALITY_THRESHOLD = 60;

const STAGES = [
  { id: 'ingest', label: 'Ingest', detail: 'Pull completed exams from Vscan Air SL sync' },
  { id: 'protocol', label: 'Protocol match', detail: 'Resolve the Caption Guidance protocol the exam ran' },
  { id: 'quality', label: 'Quality Meter', detail: 'Score every clip, keep the best per view' },
  { id: 'autoef', label: 'AutoEF', detail: 'Blend ejection fraction across EF-capable views' },
  { id: 'report', label: 'Report build', detail: 'Assemble the structured exam report' },
  { id: 'export', label: 'Export', detail: 'Push to Verisound and the site PACS' },
];

const SITES = [
  { id: 'NCH-ED', name: 'Northfield Community Hospital · Emergency Dept', city: 'Rochester, MN', program: 'POCUS' },
  { id: 'CVFM', name: 'Cedar Valley Family Medicine', city: 'Waterloo, IA', program: 'Primary care' },
  { id: 'SRH-MOB', name: 'Sierra Rural Health · Mobile clinic', city: 'Bishop, CA', program: 'Rural outreach' },
  { id: 'LCA', name: 'Lakeshore Cardiology Associates', city: 'Erie, PA', program: 'Cardiology' },
  { id: 'RHD-07', name: 'Global RHD Screening Program · Site 7', city: 'Kampala, UG', program: 'RHD screening' },
];

const DEVICES = [
  { serial: 'VSA-SL-24K0317', site: 'NCH-ED', firmware: '2.4.1', studiesToday: 9, lastSync: '04:02' },
  { serial: 'VSA-SL-24K0322', site: 'NCH-ED', firmware: '2.4.1', studiesToday: 6, lastSync: '03:58' },
  { serial: 'VSA-SL-23M1104', site: 'CVFM', firmware: '2.3.6', studiesToday: 4, lastSync: '03:41' },
  { serial: 'VSA-SL-24A0871', site: 'SRH-MOB', firmware: '2.4.1', studiesToday: 7, lastSync: '03:55' },
  { serial: 'VSA-SL-23M1190', site: 'LCA', firmware: '2.3.6', studiesToday: 11, lastSync: '04:05' },
  { serial: 'VSA-SL-24K0401', site: 'RHD-07', firmware: '2.4.1', studiesToday: 14, lastSync: '03:49' },
];

const EXPORT_TARGETS = [
  { id: 'verisound', label: 'Verisound Digital Solutions', kind: 'Fleet & exam cloud' },
  { id: 'pacs', label: 'Site PACS (DICOM SR)', kind: 'Structured report' },
];

function makeClip(view, qualityScore, frames, options = {}) {
  return {
    clipId: `${view}-${qualityScore}-${frames}`,
    view,
    doppler: options.doppler || null,
    qualityScore,
    frames,
    sampleEf: options.sampleEf,
  };
}

function buildClips(protocolId, baseline, lvef) {
  const protocol = PROTOCOLS[protocolId];
  const clips = [];
  protocol.views.forEach((view, index) => {
    const spread = ((index * 7) % 11) - 5;
    const primary = Math.min(98, Math.max(35, baseline + spread));
    const secondary = Math.max(20, primary - 12 - ((index * 3) % 9));
    clips.push(makeClip(view.code, primary, 48 + ((index * 5) % 14), { doppler: view.doppler, sampleEf: lvef }));
    clips.push(makeClip(view.code, secondary, 36 + ((index * 3) % 10), { doppler: view.doppler, sampleEf: lvef }));
  });
  return clips;
}

function seedQueue() {
  return [
    {
      studyId: 'CAI-STU-240917-0441',
      patientRef: 'PT-7F3A91',
      site: 'NCH-ED',
      device: 'VSA-SL-24K0317',
      operator: 'RN · POCUS novice',
      protocol: 'cardiac-10',
      acquiredAt: '03:47',
      clips: buildClips('cardiac-10', 81, 0.58),
    },
    {
      studyId: 'CAI-STU-240917-0442',
      patientRef: 'PT-2C88D0',
      site: 'LCA',
      device: 'VSA-SL-23M1190',
      operator: 'Sonographer',
      protocol: 'cardiac-10',
      acquiredAt: '03:51',
      clips: buildClips('cardiac-10', 88, 0.61),
    },
    {
      studyId: 'CAI-STU-240917-0443',
      patientRef: 'PT-9A1E27',
      site: 'RHD-07',
      device: 'VSA-SL-24K0401',
      operator: 'Community health worker',
      protocol: 'rhd-screening',
      acquiredAt: '03:49',
      clips: buildClips('rhd-screening', 76, 0.55),
    },
    {
      studyId: 'CAI-STU-240917-0444',
      patientRef: 'PT-4D0B63',
      site: 'SRH-MOB',
      device: 'VSA-SL-24A0871',
      operator: 'Medical assistant',
      protocol: 'cardiac-quick',
      acquiredAt: '03:55',
      clips: buildClips('cardiac-quick', 72, 0.47),
    },
    {
      studyId: 'CAI-STU-240917-0445',
      patientRef: 'PT-E15C7B',
      site: 'CVFM',
      device: 'VSA-SL-23M1104',
      operator: 'Family physician',
      protocol: 'cardiac-10',
      acquiredAt: '03:58',
      clips: buildClips('cardiac-10', 84, 0.63),
    },
  ];
}

function seedRuns() {
  const rows = [
    ['CAI-BATCH-240917-011', '03:30', 6, 6, 1840],
    ['CAI-BATCH-240917-010', '03:00', 5, 5, 1710],
    ['CAI-BATCH-240917-009', '02:30', 7, 7, 2050],
    ['CAI-BATCH-240917-008', '02:00', 4, 4, 1390],
    ['CAI-BATCH-240917-007', '01:30', 6, 6, 1902],
    ['CAI-BATCH-240917-006', '01:00', 5, 5, 1655],
  ];
  return rows.map(([batchId, startedAt, total, ef, durationMs]) => ({
    runId: uuidv4(),
    batchId,
    trigger: 'scheduler',
    startedAt,
    status: 'completed',
    stage: 'export',
    studiesTotal: total,
    studiesProcessed: total,
    autoEfComputed: ef,
    durationMs,
    error: null,
  }));
}

const QUEUE = [];
const RUNS = [];
const PROCESSED = [];
const pipelineState = { status: 'ready', degradedSince: null, lastError: null, nextBatchNo: 12 };

function seedState() {
  QUEUE.length = 0;
  QUEUE.push(...seedQueue());
  RUNS.length = 0;
  RUNS.push(...seedRuns());
  PROCESSED.length = 0;
  pipelineState.status = 'ready';
  pipelineState.degradedSince = null;
  pipelineState.lastError = null;
  pipelineState.nextBatchNo = 12;
}

seedState();

function clipKey(clip) {
  return clip.doppler ? `${clip.view}+${clip.doppler.toUpperCase()}` : clip.view;
}

function resolveProtocol(study) {
  const protocol = PROTOCOLS[study.protocol];
  if (!protocol) {
    throw new Error(`Unknown Caption Guidance protocol "${study.protocol}" on ${study.studyId}`);
  }
  return protocol;
}

function scoreClip(clip) {
  const framePenalty = clip.frames < 40 ? 4 : 0;
  return { ...clip, qualityScore: Math.max(0, clip.qualityScore - framePenalty) };
}

function selectBestClips(study) {
  const best = {};
  study.clips.map(scoreClip).forEach((clip) => {
    const key = clipKey(clip);
    if (!best[key] || clip.qualityScore > best[key].qualityScore) {
      best[key] = clip;
    }
  });
  return best;
}

function qualityGate(best, protocol) {
  const below = protocol.views
    .map((view) => ({ key: viewKey(view), clip: best[viewKey(view)] }))
    .filter(({ clip }) => !clip || clip.qualityScore < QUALITY_THRESHOLD)
    .map(({ key }) => key);
  const scores = Object.values(best).map((clip) => clip.qualityScore);
  const mean = scores.reduce((sum, score) => sum + score, 0) / scores.length;
  return { diagnostic: below.length === 0, belowThreshold: below, meanQuality: Math.round(mean) };
}

function measureVolumes(clip) {
  if (clip.doppler) {
    return null;
  }
  const edv = 92 + (clip.qualityScore % 23) * 2.5;
  const esv = Math.round(edv * (1 - clip.sampleEf) * 10) / 10;
  return { edv: Math.round(edv * 10) / 10, esv };
}

function attachVolumes(best) {
  const measured = {};
  Object.entries(best).forEach(([key, clip]) => {
    measured[key] = { ...clip, volumes: measureVolumes(clip) };
  });
  return measured;
}

function computeAutoEf(best, protocol) {
  const estimates = efViews(protocol).map((view) => {
    const clip = best[view.code];
    const { edv, esv } = clip.volumes;
    return {
      view: view.code,
      ef: ((edv - esv) / edv) * 100,
      weight: EF_VIEW_WEIGHTS[view.code] || 0.2,
    };
  });
  const totalWeight = estimates.reduce((sum, item) => sum + item.weight, 0);
  const blended = estimates.reduce((sum, item) => sum + item.ef * item.weight, 0) / totalWeight;
  return {
    lvef: Math.round(blended * 10) / 10,
    views: estimates.map((item) => ({ view: item.view, ef: Math.round(item.ef * 10) / 10 })),
  };
}

function buildReport(study, protocol, best, gate, autoEf) {
  return {
    studyId: study.studyId,
    patientRef: study.patientRef,
    site: study.site,
    protocol: protocol.name,
    protocolVersion: protocol.version,
    diagnostic: gate.diagnostic,
    meanQuality: gate.meanQuality,
    lvef: autoEf.lvef,
    efViews: autoEf.views,
    views: protocol.views.map((view) => {
      const described = describeView(view);
      const clip = best[described.key];
      return { ...described, qualityScore: clip ? clip.qualityScore : null, frames: clip ? clip.frames : null };
    }),
    exportTargets: EXPORT_TARGETS.map((target) => target.id),
  };
}

function processStudy(study, run) {
  run.stage = 'protocol';
  const protocol = resolveProtocol(study);
  run.stage = 'quality';
  const best = attachVolumes(selectBestClips(study));
  const gate = qualityGate(best, protocol);
  run.stage = 'autoef';
  const autoEf = computeAutoEf(best, protocol);
  run.stage = 'report';
  return buildReport(study, protocol, best, gate, autoEf);
}

function summarizeRun(run) {
  return {
    runId: run.runId,
    batchId: run.batchId,
    trigger: run.trigger,
    startedAt: run.startedAt,
    status: run.status,
    stage: run.stage,
    currentStudy: run.currentStudy || null,
    studiesTotal: run.studiesTotal,
    studiesProcessed: run.studiesProcessed,
    autoEfComputed: run.autoEfComputed,
    durationMs: run.durationMs,
    error: run.error,
  };
}

function clockLabel(date) {
  return date.toISOString().slice(11, 16);
}

function queueSummary() {
  return QUEUE.map((study) => {
    const protocol = PROTOCOLS[study.protocol];
    return {
      studyId: study.studyId,
      patientRef: study.patientRef,
      site: study.site,
      device: study.device,
      operator: study.operator,
      protocol: protocol ? protocol.shortName : study.protocol,
      protocolId: study.protocol,
      acquiredAt: study.acquiredAt,
      clips: study.clips.length,
      views: protocol ? protocol.views.length : 0,
    };
  });
}

function getOverview() {
  const completed = RUNS.filter((run) => run.status === 'completed');
  const failed = RUNS.filter((run) => run.status === 'failed');
  const studies24h = completed.reduce((sum, run) => sum + run.studiesProcessed, 0);
  const autoEf24h = completed.reduce((sum, run) => sum + run.autoEfComputed, 0);
  const latencies = completed.map((run) => run.durationMs);
  const meanLatency = latencies.length
    ? Math.round(latencies.reduce((sum, value) => sum + value, 0) / latencies.length)
    : 0;
  return {
    service: SERVICE,
    pipelineVersion: PIPELINE_VERSION,
    region: 'us-east-1',
    status: pipelineState.status,
    degradedSince: pipelineState.degradedSince,
    lastError: pipelineState.lastError,
    scheduler: 'Manual · auto-sweep paused during RHD protocol rollout',
    nextBatchId: `CAI-BATCH-240917-${String(pipelineState.nextBatchNo).padStart(3, '0')}`,
    summary: {
      pendingStudies: QUEUE.length,
      studiesProcessed24h: studies24h,
      autoEfComputed24h: autoEf24h,
      meanBatchLatencyMs: meanLatency,
      failedRuns: failed.length,
      lastSuccessfulRunAt: completed.length ? completed[0].startedAt : null,
      devicesOnline: DEVICES.length,
      qualityThreshold: QUALITY_THRESHOLD,
    },
    stages: STAGES,
    protocols: Object.values(PROTOCOLS).map((protocol) => ({
      id: protocol.id,
      name: protocol.name,
      shortName: protocol.shortName,
      version: protocol.version,
      rolloutNote: protocol.rolloutNote || null,
      views: protocol.views.map(describeView),
    })),
    sites: SITES,
    devices: DEVICES,
    exportTargets: EXPORT_TARGETS,
    queue: queueSummary(),
    runs: RUNS.map(summarizeRun),
  };
}

function listStudies() {
  return { pending: queueSummary(), processed: PROCESSED.slice(0, 20) };
}

async function processPendingBatch(data = {}) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const batchId = `CAI-BATCH-240917-${String(pipelineState.nextBatchNo).padStart(3, '0')}`;
  const studies = QUEUE.slice();
  const run = {
    runId: requestId,
    batchId,
    trigger: data.trigger || 'manual',
    startedAt: clockLabel(new Date()),
    status: 'running',
    stage: 'ingest',
    currentStudy: null,
    studiesTotal: studies.length,
    studiesProcessed: 0,
    autoEfComputed: 0,
    durationMs: null,
    error: null,
  };
  RUNS.unshift(run);

  logger.info('Processing pending exam batch', {
    requestId,
    batchId,
    studies: studies.map((study) => study.studyId),
    protocols: studies.map((study) => study.protocol),
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const reports = [];
    for (const study of studies) {
      run.currentStudy = study.studyId;
      const report = processStudy(study, run);
      reports.push(report);
      run.studiesProcessed += 1;
      if (report.lvef !== null && report.lvef !== undefined) {
        run.autoEfComputed += 1;
      }
    }

    run.stage = 'export';
    run.status = 'completed';
    run.currentStudy = null;
    run.durationMs = Date.now() - startTime;
    PROCESSED.unshift(...reports);
    QUEUE.length = 0;
    pipelineState.nextBatchNo += 1;

    incrementMetric('exam_pipeline.batch.success', { route: ROUTE });
    recordTiming('exam_pipeline.batch.latency', run.durationMs, { route: ROUTE });
    logger.info('Exam batch exported', {
      requestId,
      batchId,
      studies: reports.length,
      durationMs: run.durationMs,
      service: SERVICE,
    });

    return { success: true, run: summarizeRun(run), reports };
  } catch (error) {
    run.status = 'failed';
    run.durationMs = Date.now() - startTime;
    run.error = {
      type: error.name,
      message: error.message,
      stage: run.stage,
      studyId: run.currentStudy,
    };
    pipelineState.status = 'degraded';
    pipelineState.degradedSince = pipelineState.degradedSince || new Date().toISOString();
    pipelineState.lastError = { ...run.error, batchId, at: new Date().toISOString() };

    incrementMetric('exam_pipeline.batch.failure', { route: ROUTE, stage: run.stage });
    recordTiming('exam_pipeline.batch.latency', run.durationMs, { route: ROUTE });
    logger.error('Exam batch failed', {
      requestId,
      batchId,
      stage: run.stage,
      studyId: run.currentStudy,
      error: error.message,
      stack: error.stack,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: { service: SERVICE, route: ROUTE, stage: run.stage },
      extra: { requestId, batchId, studyId: run.currentStudy },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?query=${encodeURIComponent(requestId)}`,
      culprit: 'app/services/verticals/cd608144.js — processPendingBatch',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Caption AI Exam Processing Console',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'stage', value: run.stage },
      ],
      extra: {
        requestId,
        batchId,
        stage: run.stage,
        studyId: run.currentStudy,
        studiesInBatch: run.studiesTotal,
        studiesProcessed: run.studiesProcessed,
        pipelineVersion: PIPELINE_VERSION,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'cd608144@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix:
        'The console that surfaced this error is served at /cd608144. After fixing, start the app and click "Process pending studies" on that page: the batch must export every pending study, including the RHD screening exam, and the pipeline status must return to Ready.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, service: SERVICE });
    });

    throw error;
  }
}

function resetPipeline() {
  const cleared = RUNS.filter((run) => run.trigger !== 'scheduler').length + PROCESSED.length;
  seedState();
  logger.info('Demo state reset', { cleared, service: SERVICE });
  incrementMetric('exam_pipeline.reset', { route: `${ROUTE}/reset` });
  return { success: true, cleared, status: pipelineState.status, pendingStudies: QUEUE.length };
}

module.exports = {
  processPendingBatch,
  resetPipeline,
  getOverview,
  listStudies,
  STAGES,
  SITES,
  DEVICES,
  EXPORT_TARGETS,
};
