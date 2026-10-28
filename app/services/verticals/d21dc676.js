const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const catalog = require('./d21dc676-catalog');
const { generateFocusLots, describe: describeMockData, BUSINESS_DATE } = require('./d21dc676-mockdata');
const { runLegacySybal020 } = require('./d21dc676-legacy');
const {
  COBOL_ANALYST, JAVA_TRANSLATOR, MOCKDATA_GEN, PARITY_VERIFIER,
  mapField, analyzeCobol, translateProgram, executePlan, verifyParity, renderJava,
} = require('./d21dc676-agents');

/**
 * d21dc676 — Sysco Migration Cockpit for the Forward Arrow nightly inventory
 * close (COBOL → Java Spring Boot, Step Functions, Aurora PostgreSQL).
 *
 * "Run parallel validation" hands a batch job to the orchestrator, which
 * dispatches the COBOL analyst, Java translator, mock data generator and
 * parity verifier, and returns the parity result when legacy and Java
 * outputs match.
 */

const SLACK_MEMBER_ID = process.env.CD21DC676_SLACK_MEMBER_ID || '';
const ROUTE = '/api/d21dc676/parallel-run';
const SERVICE = 'inventory-close-migration-orchestrator';
const MOCK_ROWS = 1200;

const { COPYBOOKS, JOBS, SYBAL020_SOURCE } = catalog;

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'A migration subagent paused the parallel run for a Sysco nightly inventory close job (COBOL → Java Spring Boot) and escalated a question to the on-call channel. Treat it as two jobs:',
  '1. *Answer the question.* The approved COBOL → Java conversion rules and parity tolerances live in the repo; use them as the source of truth and reply in the Slack thread with the answer and where it comes from.',
  '2. *Unblock the job.* If the approved rules already answer it, the subagent should never have escalated. Find out why the Java translation diverged from the legacy output and fix it so the parallel run passes end to end.',
  '',
  'Code path for the Migration Cockpit "Run parallel validation" action:',
  '- Orchestrator: `app/services/verticals/d21dc676.js`',
  '- Subagents: `app/services/verticals/d21dc676-agents.js`',
  '- Conversion rules: `app/services/verticals/d21dc676-conversion-rules.js`',
  '- Legacy output (parallel run): `app/services/verticals/d21dc676-legacy.js`',
  '- Catalog (jobs, copybooks, COBOL source): `app/services/verticals/d21dc676-catalog.js`',
  '- Route: `app/routes/verticals/d21dc676.js`',
  '- Page: `app/public/verticals/d21dc676.html` (served at `/d21dc676`)',
  '',
  'The jobs, copybooks and data are a synthetic model for the demo, not a description of the customer\'s real systems.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code, statusCode = 400) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = statusCode;
  return error;
}

function getCockpit() {
  return {
    program: catalog.PROGRAM,
    jobs: JOBS.map((job) => {
      const summary = { ...job };
      delete summary.cobolExcerpt;
      delete summary.javaExcerpt;
      return summary;
    }),
    workstreams: catalog.WORKSTREAMS,
    milestones: catalog.MILESTONES,
    team: catalog.TEAM,
    risks: catalog.RISKS,
    decisions: catalog.DECISIONS,
    schemas: catalog.SCHEMAS,
    parityRuns: catalog.PARITY_RUNS,
    uiChecks: catalog.UI_CHECKS,
    mockData: { ...describeMockData(), rows: MOCK_ROWS, sample: generateFocusLots({ rows: 8 }) },
  };
}

function findJob(jobId) {
  const job = JOBS.find((entry) => entry.id === String(jobId || '').toUpperCase());
  if (!job) throw validationError(`Unknown batch job ${jobId}.`, 'JOB_NOT_FOUND', 404);
  return job;
}

function translationFor(job) {
  const statements = analyzeCobol(SYBAL020_SOURCE);
  const plan = translateProgram(statements, COPYBOOKS[job.copybook]);
  return { statements, plan };
}

function getJob(jobId) {
  const job = findJob(jobId);
  const copybook = COPYBOOKS[job.copybook];
  const detail = {
    ...job,
    copybookDetail: { name: copybook.name, description: copybook.description, table: copybook.table || null },
    fieldMappings: copybook.fields.map(mapField),
  };
  if (job.live) {
    const { plan } = translationFor(job);
    const input = COPYBOOKS[job.sourceCopybook];
    detail.cobolSource = SYBAL020_SOURCE;
    detail.javaSource = renderJava(plan, input, copybook).split('\n');
    detail.inputMappings = input.fields.map(mapField);
  } else {
    detail.cobolSource = job.cobolExcerpt;
    detail.javaSource = job.javaExcerpt;
  }
  delete detail.cobolExcerpt;
  delete detail.javaExcerpt;
  return detail;
}

function runPipeline(job, steps) {
  const { statements, plan } = translationFor(job);
  steps.push({ agent: COBOL_ANALYST, target: job.program, status: 'ok', detail: `${statements.length} statements parsed from 2000-CALC-BEGIN-BAL` });
  steps.push({ agent: JAVA_TRANSLATOR, target: job.javaClass, status: 'ok', detail: `${plan.length} statements translated to BeginningBalanceProcessor` });

  const lots = generateFocusLots({ rows: MOCK_ROWS });
  steps.push({ agent: MOCKDATA_GEN, target: 'FOCLOT', status: 'ok', detail: `${lots.length.toLocaleString('en-US')} mock lots generated from the shared schema` });

  const legacyRows = runLegacySybal020(lots);
  const javaRows = executePlan(plan, lots, { 'WS-BUS-DT': BUSINESS_DATE });
  const parity = verifyParity({
    job, legacyRows, javaRows, outputCopybook: COPYBOOKS[job.copybook],
  });
  steps.push({ agent: PARITY_VERIFIER, target: 'LBBAL', status: 'ok', detail: `${parity.cellsCompared.toLocaleString('en-US')} values compared · parity ${parity.parity}%` });
  return { parity, sample: javaRows.slice(0, 8), legacySample: legacyRows.slice(0, 8) };
}

/**
 * Run the legacy and modernized versions of a job on the same mock data and
 * compare their outputs.
 */
async function runParallelValidation(data) {
  const startTime = Date.now();
  const runId = uuidv4();
  const job = findJob(data.jobId || 'FA-BAT-02');
  if (!job.live) {
    throw validationError(`${job.id} has not reached parallel run yet.`, 'JOB_NOT_READY');
  }
  const steps = [];

  logger.info('Starting parallel validation', {
    runId, job: job.id, program: job.program, rows: MOCK_ROWS, service: SERVICE, route: ROUTE,
  });

  try {
    const result = runPipeline(job, steps);
    const duration = Date.now() - startTime;

    incrementMetric('d21dc676.parallel_run_passed', { route: ROUTE, job: job.id });
    recordTiming('d21dc676.parallel_run_latency', duration, { route: ROUTE, job: job.id });
    logger.info('Parallel validation passed', {
      runId, job: job.id, durationMs: duration, service: SERVICE,
    });

    return {
      runId, job: job.id, status: 'passed', steps, ...result,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    error.steps = steps;

    incrementMetric('d21dc676.parallel_run_failure', {
      route: ROUTE, job: job.id, agent: error.agent || 'orchestrator', errorClass: error.name,
    });
    recordTiming('d21dc676.parallel_run_latency', duration, { route: ROUTE, job: job.id, error: 'true' });

    logger.error('Parallel validation paused', {
      runId,
      job: job.id,
      agent: error.agent,
      error: error.message,
      errorClass: error.name,
      details: error.details,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, job: job.id, agent: error.agent || 'orchestrator', alert_path: 'instant',
      },
      extra: {
        runId, program: job.program, details: error.details, steps,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: `app/services/verticals/d21dc676-agents.js \u2014 ${error.agent || 'orchestrator'}`,
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'Sysco \u2014 Batch Migration Cockpit',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: 'd21dc676',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'job', value: job.id },
        { key: 'program', value: job.program },
        { key: 'agent', value: error.agent || 'orchestrator' },
      ],
      extra: {
        runId, job: job.id, program: job.program, details: error.details,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'd21dc676@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session', { error: err.message, runId });
    });

    throw error;
  }
}

module.exports = {
  getCockpit,
  getJob,
  runParallelValidation,
};
