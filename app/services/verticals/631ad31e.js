const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const { PROGRAM, WAVES, WAVE_TABLES } = require('./631ad31e-catalog');
const {
  SCHEMA_MAPPER, DATA_VALIDATOR, planTable, validateLineage, renderDeltaDdl,
} = require('./631ad31e-agents');

/**
 * 631ad31e — Migration Cockpit for the Teradata EDW → Databricks program.
 *
 * "Resume wave" hands the wave's remaining tables to the orchestrator, which
 * dispatches the schema mapper and data validator subagents per table and
 * returns the Delta DDL for every table that cleared both.
 */

const SLACK_MEMBER_ID = process.env.C631AD31E_SLACK_MEMBER_ID || '';
const ROUTE = '/api/631ad31e/resume-wave';
const SERVICE = 'edw-migration-orchestrator';

const REMEDIATION_DIRECTIVE = [
  '*Repository to investigate and fix:* `COG-GTM/event-driven-devin`',
  '',
  'A migration subagent paused a wave of the Teradata → Databricks migration and escalated a question to the on-call channel. Treat it as two jobs:',
  '1. *Answer the question.* The approved Teradata → Delta type mappings live in the repo; use them as the source of truth and reply in the Slack thread with the answer and where it comes from.',
  '2. *Unblock the wave.* If the approved mappings already answer it, the subagent should never have escalated — find out why it could not resolve the mapping and fix it so the wave resumes end to end.',
  '',
  'Code path for the Migration Cockpit "Resume wave" action:',
  '- Orchestrator: `app/services/verticals/631ad31e.js`',
  '- Subagents: `app/services/verticals/631ad31e-agents.js`',
  '- Type mappings: `app/services/verticals/631ad31e-type-rules.js`',
  '- Catalog: `app/services/verticals/631ad31e-catalog.js`',
  '- Route: `app/routes/verticals/631ad31e.js`',
  '- Page: `app/public/verticals/631ad31e.html` (served at `/631ad31e`)',
  '',
  'The warehouse, waves and tables are a synthetic model for the demo, not a description of the customer\'s real systems.',
  '',
  'Open a pull request against `main` with the fix.',
].join('\n');

function validationError(message, code) {
  const error = new Error(message);
  error.name = 'ValidationError';
  error.code = code;
  error.statusCode = 400;
  return error;
}

function getCockpit() {
  return { program: PROGRAM, waves: WAVES };
}

function resolveWave(waveId) {
  const wave = WAVES.find((entry) => entry.id === (waveId || 'W3'));
  if (!wave) throw validationError('Select a migration wave to resume.', 'WAVE_REQUIRED');
  if (!WAVE_TABLES[wave.id]) {
    throw validationError(`Wave ${wave.id} has no tables waiting at a checkpoint.`, 'WAVE_NOT_AT_CHECKPOINT');
  }
  return wave;
}

function runTable(table, wave, steps) {
  const plan = planTable(table, wave);
  steps.push({ agent: SCHEMA_MAPPER, table: plan.source, status: 'ok', detail: `${plan.columns.length} columns mapped` });
  const lineage = validateLineage(table, plan);
  steps.push({ agent: DATA_VALIDATOR, table: plan.source, status: 'ok', detail: `lineage ${lineage.lineage}` });
  return {
    source: plan.source, target: plan.table, rows: table.rows, ddl: renderDeltaDdl(plan),
  };
}

/**
 * Resume a wave paused at a checkpoint.
 */
async function resumeWave(data) {
  const startTime = Date.now();
  const runId = uuidv4();
  const wave = resolveWave(data.waveId);
  const tables = WAVE_TABLES[wave.id];
  const steps = [];

  logger.info('Resuming migration wave', {
    runId, wave: wave.id, database: wave.database, tables: tables.length, service: SERVICE, route: ROUTE,
  });

  try {
    const landed = tables.map((table) => runTable(table, wave, steps));
    const duration = Date.now() - startTime;

    incrementMetric('631ad31e.wave_resumed', { route: ROUTE, wave: wave.id });
    recordTiming('631ad31e.wave_resume_latency', duration, { route: ROUTE, wave: wave.id });
    logger.info('Migration wave resumed', {
      runId, wave: wave.id, tablesLanded: landed.length, durationMs: duration, service: SERVICE,
    });

    return {
      runId, wave: wave.id, status: 'running', steps, tables: landed,
    };
  } catch (error) {
    const duration = Date.now() - startTime;
    error.steps = steps;

    incrementMetric('631ad31e.wave_resume_failure', {
      route: ROUTE, wave: wave.id, agent: error.agent || 'orchestrator', errorClass: error.name,
    });
    recordTiming('631ad31e.wave_resume_latency', duration, { route: ROUTE, wave: wave.id, error: 'true' });

    logger.error('Migration wave paused', {
      runId,
      wave: wave.id,
      agent: error.agent,
      error: error.message,
      errorClass: error.name,
      details: error.details,
      durationMs: duration,
      service: SERVICE,
    });

    Sentry.captureException(error, {
      tags: {
        route: ROUTE, service: SERVICE, wave: wave.id, agent: error.agent || 'orchestrator', alert_path: 'instant',
      },
      extra: { runId, database: wave.database, details: error.details, steps },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: `app/services/verticals/631ad31e-agents.js \u2014 ${error.agent || 'orchestrator'}`,
      errorType: error.name || 'Error',
      errorValue: error.message,
      devinUserId: data.devinUserId,
      devinEmail: data.devinEmail,
      devinOrgId: data.devinOrgId,
      service: SERVICE,
      verticalLabel: 'TD \u2014 EDW Migration Cockpit',
      promptAppendix: REMEDIATION_DIRECTIVE,
      customer: '631ad31e',
      slackMemberId: data.devinEmail ? '' : SLACK_MEMBER_ID,
      slackMemberIdFallback: SLACK_MEMBER_ID,
      tags: [
        { key: 'route', value: ROUTE },
        { key: 'service', value: SERVICE },
        { key: 'wave', value: wave.id },
        { key: 'agent', value: error.agent || 'orchestrator' },
        { key: 'database', value: wave.database },
      ],
      extra: {
        runId, wave: wave.id, database: wave.database, details: error.details,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || '631ad31e@1.0.0',
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
  resumeWave,
};
