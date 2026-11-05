const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { TARGETS, resolveTarget, slaMinutes, revocationSteps } = require('./bceeea47-targets');

const SERVICE = 'bceeea47-api';
const ROUTE = '/api/bceeea47/revocations/run';
const SLACK_MEMBER_ID = 'U0BDHHQUM24';

const REGIONS = [
  { id: 'AMER', name: 'Americas' },
  { id: 'EMEA', name: 'Europe' },
  { id: 'APAC', name: 'Asia & Oceania' },
  { id: 'JP', name: 'Japan' },
];

const QUEUE = [
  { id: 'LVR-24117', name: 'D. Okafor', role: 'Plant controls engineer (contractor)', employer: 'Contractor', region: 'AMER', tier: 'privileged', systems: ['sso', 'ad', 'vpn', 'm365', 'ot-jumphost'], hrEventAt: '2026-11-04T14:05:00Z' },
  { id: 'LVR-24118', name: 'M. Lindqvist', role: 'Service advisor', employer: 'Dealer', region: 'EMEA', tier: 'standard', systems: ['sso', 'dealer-portal'], hrEventAt: '2026-11-04T14:12:00Z' },
  { id: 'LVR-24119', name: 'R. Patel', role: 'Network operations analyst', employer: 'Associate', region: 'AMER', tier: 'privileged', systems: ['sso', 'ad', 'vpn', 'm365', 'ot-jumphost', 'scm'], hrEventAt: '2026-11-04T14:20:00Z' },
  { id: 'LVR-24120', name: 'A. Nakamura', role: 'Supplier quality associate', employer: 'Associate', region: 'JP', tier: 'standard', systems: ['sso', 'ad', 'm365'], hrEventAt: '2026-11-04T14:31:00Z' },
  { id: 'LVR-24121', name: 'S. Mbeki', role: 'Parts specialist', employer: 'Dealer', region: 'APAC', tier: 'standard', systems: ['sso', 'dealer-portal'], hrEventAt: '2026-11-04T14:44:00Z' },
  { id: 'LVR-24122', name: 'J. Romero', role: 'Infrastructure engineer (contractor)', employer: 'Contractor', region: 'AMER', tier: 'privileged', systems: ['sso', 'ad', 'vpn', 'ot-jumphost', 'scm'], hrEventAt: '2026-11-04T14:50:00Z' },
  { id: 'LVR-24123', name: 'L. Fischer', role: 'Marketing coordinator', employer: 'Associate', region: 'EMEA', tier: 'standard', systems: ['sso', 'ad', 'm365'], hrEventAt: '2026-11-04T15:02:00Z' },
];

const COMPLETED_TODAY = 9;
const BATCHES = [];
let resetEpoch = 0;
let running = false;

function planFor(leaver) {
  return leaver.systems.flatMap((systemId) => {
    const target = resolveTarget(systemId);
    if (!target) return [];
    return revocationSteps(target, leaver);
  });
}

function executePlan(leaver, plan) {
  return plan.map((step) => ({
    leaverId: leaver.id,
    target: step.target,
    action: step.action.toUpperCase(),
    completedAt: new Date().toISOString(),
  }));
}

function summarize(results) {
  const byTarget = {};
  for (const result of results) {
    byTarget[result.target] = (byTarget[result.target] || 0) + 1;
  }
  return { steps: results.length, byTarget };
}

function deadlineFor(leaver) {
  return new Date(new Date(leaver.hrEventAt).getTime() + slaMinutes(leaver.tier) * 60000).toISOString();
}

function queueView() {
  return QUEUE.map((leaver) => ({
    ...leaver,
    deadline: deadlineFor(leaver),
    targets: leaver.systems.map((id) => (resolveTarget(id) || { name: id }).name),
  }));
}

function currentStatus() {
  const last = BATCHES[0];
  const privilegedPending = QUEUE.filter((l) => l.tier === 'privileged').length;
  if (last && last.status === 'failed') {
    return { state: 'degraded', text: `Revocation batch failed · ${privilegedPending} privileged accounts past SLA`, privilegedAtRisk: privilegedPending };
  }
  return { state: 'ok', text: 'All connectors healthy · queue within SLA', privilegedAtRisk: 0 };
}

function getOverview() {
  const privileged = QUEUE.filter((l) => l.tier === 'privileged').length;
  return {
    regions: REGIONS,
    targets: TARGETS,
    queue: queueView(),
    batches: BATCHES,
    kpis: {
      leaverEventsToday: COMPLETED_TODAY + QUEUE.length,
      revokedToday: COMPLETED_TODAY,
      pending: QUEUE.length,
      privilegedPending: privileged,
    },
    status: currentStatus(),
  };
}

function formatBatch(batchId, leaverResults, durationMs) {
  const steps = leaverResults.reduce((n, r) => n + r.summary.steps, 0);
  return {
    batchId,
    status: 'complete',
    leavers: leaverResults.length,
    steps,
    durationMs,
    completedAt: new Date().toISOString(),
  };
}

async function runRevocationBatch(data) {
  const startTime = Date.now();
  const epoch = resetEpoch;
  const requestId = uuidv4();
  const batchId = `RVB-${requestId.slice(0, 8).toUpperCase()}`;
  running = true;

  logger.info('Running leaver revocation batch', { requestId, batchId, leavers: QUEUE.length, service: SERVICE });

  try {
    await new Promise((resolve) => setTimeout(resolve, 70 + Math.random() * 110));

    const leaverResults = [];
    for (const leaver of QUEUE) {
      const plan = planFor(leaver);
      const results = executePlan(leaver, plan);
      leaverResults.push({ leaverId: leaver.id, summary: summarize(results) });
    }

    const batch = formatBatch(batchId, leaverResults, Date.now() - startTime);
    if (epoch === resetEpoch) {
      BATCHES.unshift(batch);
      BATCHES.splice(20);
    }
    incrementMetric('revocation.batch.success', { route: ROUTE });
    recordTiming('revocation.batch.latency', Date.now() - startTime, { route: ROUTE });
    return { success: true, requestId, batch, status: currentStatus() };
  } catch (error) {
    const duration = Date.now() - startTime;
    const privilegedPending = QUEUE.filter((l) => l.tier === 'privileged');

    incrementMetric('revocation.batch.failure', { route: ROUTE, errorClass: error.name });
    recordTiming('revocation.batch.latency', duration, { route: ROUTE, error: 'true' });

    logger.error('Leaver revocation batch failed', {
      requestId,
      batchId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      service: SERVICE,
    });

    if (epoch === resetEpoch) {
      BATCHES.unshift({
        batchId,
        status: 'failed',
        leavers: QUEUE.length,
        steps: 0,
        durationMs: duration,
        error: `${error.name}: ${error.message}`,
        completedAt: new Date().toISOString(),
      });
      BATCHES.splice(20);
    }

    Sentry.captureException(error, {
      tags: { route: ROUTE, service: SERVICE, alert_path: 'instant' },
      extra: { requestId, batchId, leavers: QUEUE.length, privilegedPending: privilegedPending.length },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/bceeea47.js — runRevocationBatch',
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Identity Access Operations — Leaver Revocation',
      slackMemberId: SLACK_MEMBER_ID,
      skipVulnerablePr: true,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'batch', value: batchId },
      ],
      extra: {
        requestId,
        batchId,
        leavers: QUEUE.map((l) => ({ id: l.id, region: l.region, tier: l.tier, systems: l.systems })),
        privilegedPending: privilegedPending.map((l) => l.id),
        promptContext: `The leaver access-revocation batch (${batchId}) aborted before any account was disabled. ${privilegedPending.length} privileged leavers (${privilegedPending.map((l) => l.id).join(', ')}) still hold plant-network and directory access past their 60-minute revocation SLA; ${QUEUE.length} leaver events remain queued. The batch builds a per-leaver plan from the connected-system definitions in app/services/verticals/bceeea47-targets.js and executes it in app/services/verticals/bceeea47.js.`,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'bceeea47@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
      promptAppendix: 'Fix the revocation batch so every queued leaver, including privileged leavers with plant-network jump-host access, completes with a step recorded for each connected system (credential rotation included). Add a regression test in tests/ that runs the batch and asserts a complete status with a step count for every leaver, and verify the fix in the browser on /bceeea47 by clicking Run revocation batch.',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from revocation batch error', { error: err.message });
    });

    throw error;
  } finally {
    running = false;
  }
}

function resetRevocations() {
  if (running) {
    return { success: false, reason: 'A revocation batch is in flight; retry once it finishes.', status: currentStatus() };
  }
  resetEpoch += 1;
  const cleared = BATCHES.length;
  BATCHES.length = 0;
  logger.info('Demo state reset', { cleared, service: SERVICE });
  incrementMetric('revocation.reset', { route: '/api/bceeea47/revocations/reset' });
  return { success: true, cleared, status: currentStatus() };
}

module.exports = { runRevocationBatch, resetRevocations, getOverview, QUEUE, REGIONS, TARGETS };
