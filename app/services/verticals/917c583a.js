const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { resolveProfile, listProfiles } = require('./917c583a-profiles');

const ROUTE = '/api/917c583a/cache-sync';
const SERVICE = '917c583a-api';
const FAILURE_RATIO_THRESHOLD = 0.2;
const MB_PER_SEC_PER_WORKER = 12;

const CACHE_JOBS = [
  {
    id: 's3cp-see-spray-imagery',
    source: 's3://mesa-fleet-data-usw2/see-spray/imagery/',
    target: 'mesa-cache-usw2:/imagery',
    profile: 'bulk',
    objects: 18420,
    sizeGb: 412.6,
    windowSec: 7200,
    owner: 'perception-data',
  },
  {
    id: 's3cp-model-artifacts',
    source: 's3://mesa-ml-artifacts/models/weed-detect/',
    target: 'mesa-cache-usw2:/models',
    profile: 'hot',
    objects: 214,
    sizeGb: 38.4,
    windowSec: 900,
    owner: 'ml-platform',
  },
  {
    id: 's3cp-machine-state-logs',
    source: 's3://mesa-fleet-data-usw2/machine-state/',
    target: 'mesa-cache-usw2:/machine-state',
    profile: 'hot',
    objects: 96310,
    sizeGb: 22.9,
    windowSec: 900,
    owner: 'fleet-ops',
  },
  {
    id: 's3cp-hil-bench-results',
    source: 's3://mesa-hil-results/benches/',
    target: 'mesa-cache-usw2:/hil',
    profile: 'standard',
    objects: 6875,
    sizeGb: 61.2,
    windowSec: 1800,
    owner: 'test-infra',
  },
  {
    id: 's3cp-field-test-telemetry',
    source: 's3://mesa-fleet-data-usw2/field-test/telemetry/',
    target: 'mesa-cache-usw2:/field-test',
    profile: 'standard',
    objects: 41208,
    sizeGb: 97.5,
    windowSec: 1800,
    owner: 'field-engineering',
  },
  {
    id: 's3cp-calibration-bundles',
    source: 's3://mesa-calibration/bundles/',
    target: 'mesa-cache-usw2:/calibration',
    profile: 'hot',
    objects: 1290,
    sizeGb: 4.8,
    windowSec: 900,
    owner: 'perception-data',
  },
];

const RECENT_DEPLOYS = [
  { sha: '7c41e0b', title: 'perf(s3cp): precompute retry backoff schedule per cache profile', author: 'e.suchkov', ticket: 'MESASW-48190', deployedAt: '2026-10-13T22:41:00Z' },
  { sha: 'b92d5a3', title: 'chore(grafana): add hourly bars for HIL wait vs normal', author: 'b.mcmoran', ticket: 'MESASW-48102', deployedAt: '2026-10-13T17:05:00Z' },
  { sha: '0f6ac18', title: 'feat(s3cp): add calibration bundle cache job', author: 'a.wells', ticket: 'MESASVC-3317', deployedAt: '2026-10-12T19:22:00Z' },
  { sha: 'e3b7f42', title: 'fix(alerting): alert on S3CP cache job failure ratio instead of count', author: 'e.suchkov', ticket: 'MESASW-47961', deployedAt: '2026-10-10T16:48:00Z' },
];

const BASELINE_RATIOS = [0, 0, 0.167, 0, 0, 0, 0.167, 0, 0, 0, 0, 0];

const CYCLES = [];
let historyEpoch = 0;

function recordCycle(epoch, cycle) {
  if (epoch !== historyEpoch) return;
  CYCLES.unshift(cycle);
  CYCLES.splice(24);
}

function retryBudgetMs(retry) {
  let total = 0;
  let delay = retry.backoff.baseMs;
  for (let attempt = 1; attempt < retry.attempts; attempt += 1) {
    total += delay;
    delay = Math.min(delay * retry.backoff.factor, retry.backoff.capMs);
  }
  return total;
}

function objectTimeoutMs(profile) {
  return profile.partSizeMb * 120 + profile.retry.backoff.capMs;
}

function describeRetry(retry) {
  return `${retry.attempts}x exp ${retry.backoff.baseMs}ms x${retry.backoff.factor}`;
}

function planJob(job) {
  const profile = resolveProfile(job.profile);
  const transferMs = Math.round((job.sizeGb * 1024) / (profile.concurrency * MB_PER_SEC_PER_WORKER) * 1000);
  const budgetMs = retryBudgetMs(profile.retry);
  return {
    job,
    profile,
    transferMs,
    retryBudgetMs: budgetMs,
    objectTimeoutMs: objectTimeoutMs(profile),
    deadlineMs: job.windowSec * 1000,
  };
}

function executeJob(plan) {
  const { job, profile } = plan;
  const projectedMs = plan.transferMs + plan.retryBudgetMs;
  const withinWindow = projectedMs <= plan.deadlineMs;
  return {
    jobId: job.id,
    profile: profile.name,
    retry: describeRetry(profile.retry),
    objects: job.objects,
    sizeGb: job.sizeGb,
    projectedSec: Math.round(projectedMs / 100) / 10,
    objectTimeoutSec: Math.round(plan.objectTimeoutMs / 100) / 10,
    status: withinWindow ? 'succeeded' : 'failed',
  };
}

function summarizeCycle(cycleId, results) {
  const failed = results.filter((result) => result.status !== 'succeeded').length;
  const ratio = Math.round((failed / Math.max(results.length, 1)) * 1000) / 1000;
  return {
    cycleId,
    completedAt: new Date().toISOString(),
    jobs: results,
    jobCount: results.length,
    failedJobs: failed,
    failureRatio: ratio,
    alertState: ratio > FAILURE_RATIO_THRESHOLD ? 'firing' : 'normal',
  };
}

function alertState() {
  if (CYCLES.length === 0) return 'normal';
  return CYCLES[0].alertState;
}

function serviceHealth() {
  if (CYCLES.length === 0) return 'standby';
  return CYCLES[0].status === 'failed' ? 'degraded' : 'healthy';
}

async function runCacheSyncCycle(data) {
  const startTime = Date.now();
  const requestId = uuidv4();
  const cycleId = `S3CP-${requestId.slice(0, 8).toUpperCase()}`;
  const epoch = historyEpoch;

  logger.info('Starting S3CP cache sync cycle', {
    requestId,
    cycleId,
    jobs: CACHE_JOBS.length,
    service: SERVICE,
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));
    const results = CACHE_JOBS.map((job) => executeJob(planJob(job)));
    const summary = summarizeCycle(cycleId, results);
    recordCycle(epoch, { ...summary, status: 'complete' });
    incrementMetric('s3cp.cycle.success', { route: ROUTE });
    recordTiming('s3cp.cycle.latency', Date.now() - startTime, { route: ROUTE });
    logger.info('S3CP cache sync cycle complete', {
      requestId,
      cycleId,
      failedJobs: summary.failedJobs,
      failureRatio: summary.failureRatio,
      service: SERVICE,
    });
    return { success: true, requestId, cycle: summary, health: serviceHealth() };
  } catch (error) {
    const duration = Date.now() - startTime;
    incrementMetric('s3cp.cycle.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('s3cp.cycle.latency', duration, { route: ROUTE, error: 'true' });
    logger.error('S3CP cache sync cycle failed', {
      requestId,
      cycleId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });
    recordCycle(epoch, {
      cycleId,
      status: 'failed',
      completedAt: new Date().toISOString(),
      jobCount: CACHE_JOBS.length,
      failedJobs: CACHE_JOBS.length,
      failureRatio: 1,
      alertState: 'firing',
      error: `${error.name}: ${error.message}`,
    });
    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, alert_path: 'instant' },
      extra: { requestId, cycleId },
    });
    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/917c583a.js — runCacheSyncCycle',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Platform Infrastructure Monitoring — S3CP Cache Jobs',
      slackMemberId: 'U0BDHHQUM24',
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'alert_rule', value: 'S3CP cache job failure ratio > 20%' },
      ],
      extra: {
        requestId,
        cycleId,
        jobs: CACHE_JOBS.map((job) => job.id),
        failureRatio: 1,
        threshold: FAILURE_RATIO_THRESHOLD,
        promptContext: `Grafana alert "S3CP cache job failure ratio > 20% (platform-infrastructure)" is firing: the S3CP cache sync cycle ${cycleId} failed before any of its ${CACHE_JOBS.length} cache jobs copied an object, so the failure ratio is 100%. Imagery, model artifacts, machine-state logs, HIL results, field-test telemetry and calibration bundles stop refreshing in the regional cache until a cycle completes. Recent deploys on this service: ${RECENT_DEPLOYS.slice(0, 3).map((d) => `${d.sha} ${d.title}`).join('; ')}.`,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '917c583a@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: 'S3CP cache job failure ratio > 20% for 2m',
      promptAppendix: 'Before changing code, post a 5-line RCA (what, when, why, blast radius, fix) that names the responsible change and the metric. Reference Jira key MESASW-48231 in the PR title. After fixing, add a unit test that runs a full cache sync cycle across every cache job and asserts every job reports a finite retry budget and object timeout, then verify on /917c583a that the alert state returns to Normal.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from S3CP cache sync error', { error: err.message });
    });
    throw error;
  }
}

function resetCacheSync() {
  const cleared = CYCLES.length;
  CYCLES.length = 0;
  historyEpoch += 1;
  logger.info('S3CP cache sync demo state reset', { cleared, service: SERVICE });
  incrementMetric('s3cp.reset', { route: `${ROUTE}/reset` });
  return { success: true, cleared, health: serviceHealth(), alertState: alertState() };
}

function getOverview() {
  return {
    jobs: CACHE_JOBS,
    profiles: listProfiles().map((profile) => ({
      name: profile.name,
      concurrency: profile.concurrency,
      partSizeMb: profile.partSizeMb,
      ttlHours: profile.ttlHours,
      attempts: profile.retry.attempts,
    })),
    deploys: RECENT_DEPLOYS,
    baseline: BASELINE_RATIOS,
    cycles: CYCLES,
    threshold: FAILURE_RATIO_THRESHOLD,
    health: serviceHealth(),
    alertState: alertState(),
  };
}

module.exports = { runCacheSyncCycle, resetCacheSync, getOverview, CACHE_JOBS, RECENT_DEPLOYS };
