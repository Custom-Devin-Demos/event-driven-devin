const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { createSessionAndAlert } = require('../devin-session');

const PIPELINE_DIR = path.join(__dirname, '..', '..', '..', 'pipelines', 'c0e5ab62');
const MIGRATION_RUN_PATH = path.join(PIPELINE_DIR, 'reports', 'migration-run.json');
const VALIDATION_REPORT_PATH = path.join(PIPELINE_DIR, 'reports', 'validation-report.json');
const TABLES = ['customers', 'accounts', 'invoices'];
const ALERT_COOLDOWN_MS = Number(process.env.MIGRATION_ALERT_COOLDOWN_MS) || 10 * 60 * 1000;

let lastAlertAt = 0;

const VALIDATION_DIRECTIVE = [
  '*The row counts are only the visible part. Validate the whole migration and fix it at the source.*',
  '',
  'The billing estate was copied from the data-centre database (source) to the cloud database (target) by `pipelines/c0e5ab62/migrate.js`. The migration reported `completed`, but the post-migration row-count check disagrees. Both databases are plain Postgres and run locally: `npm run c0e5ab62:up` starts them (source on 55432, target on 55433, seeded deterministically), `npm run c0e5ab62:migrate` reruns the migration. `pipelines/c0e5ab62/README.md` has the details and the report format.',
  '',
  'Work from the data, not from reading the script first:',
  '1. Write comparison queries across both databases for every table: row counts, per-table checksums, then column-by-column value comparisons keyed on the primary key. Commit them under `pipelines/c0e5ab62/` so the validation is repeatable.',
  '2. Run them and record every difference in `pipelines/c0e5ab62/reports/validation-report.json` (format in the README). The dashboard at `/c0e5ab62` reads that file. Screenshot the dashboard once it is filled in — this is the "before".',
  '3. Group the differences by root cause. For each cause give the tables and row counts affected, a sample source/target pair, and the exact line in `pipelines/c0e5ab62/migrate.js` that produces it.',
  '4. Fix the migration script for every cause. Do not edit the source data and do not patch rows in the target by hand.',
  '5. Rerun the migration and rerun the same comparison. Append the new run to the report. Repeat until the comparison ends at zero differences, then screenshot the dashboard again — the "after".',
  '6. Open a pull request with the comparison queries, the script fix, both dashboard screenshots, and three numbers: differences found, causes identified, and time from the first comparison run to zero differences.',
  '',
  'Reply in this thread when the comparison is at zero, with those three numbers and the pull request link.',
].join('\n');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function rowCountCheck(migrationRun) {
  const counts = (migrationRun && migrationRun.rowCounts) || { source: {}, target: {} };
  const tables = TABLES.map((table) => {
    const source = Number(counts.source[table]) || 0;
    const target = Number(counts.target[table]) || 0;
    return { table, source, target, delta: target - source };
  });
  return {
    tables,
    drift: tables.filter((entry) => entry.delta !== 0),
    sourceRows: tables.reduce((sum, entry) => sum + entry.source, 0),
    targetRows: tables.reduce((sum, entry) => sum + entry.target, 0),
  };
}

function summariseValidation(report) {
  const runs = (report && Array.isArray(report.runs)) ? report.runs : [];
  if (!runs.length) return null;
  const first = runs[0];
  const latest = runs[runs.length - 1];
  const zeroRun = runs.find((run) => Number(run.totalDifferences) === 0);
  return {
    runs: runs.map((run) => ({ runAt: run.runAt, totalDifferences: Number(run.totalDifferences) || 0 })),
    differencesFound: Number(first.totalDifferences) || 0,
    causesIdentified: (first.causes || []).length,
    remaining: Number(latest.totalDifferences) || 0,
    msToZero: zeroRun ? new Date(zeroRun.runAt) - new Date(first.runAt) : null,
    first,
    latest,
  };
}

function getDashboard() {
  const migrationRun = readJson(MIGRATION_RUN_PATH);
  return {
    migration: migrationRun && {
      status: migrationRun.status,
      startedAt: migrationRun.startedAt,
      finishedAt: migrationRun.finishedAt,
      batches: migrationRun.batches,
      warnings: migrationRun.warnings,
    },
    rowCounts: rowCountCheck(migrationRun),
    validation: summariseValidation(readJson(VALIDATION_REPORT_PATH)),
  };
}

/**
 * Post-migration row-count check. Drift between source and target raises one
 * alert (per cooldown window) and hands the full validation to a Devin session.
 */
async function runValidation(request = {}) {
  const checkId = uuidv4();
  const check = rowCountCheck(readJson(MIGRATION_RUN_PATH));
  const result = { checkId, checkedAt: new Date().toISOString(), ...check, alerted: false };

  logger.info('Post-migration row-count check', {
    checkId,
    drift: check.drift.length,
    service: 'billing-migration',
    route: '/api/c0e5ab62/validate',
  });

  if (!check.drift.length) return { ...result, status: 'match' };
  result.status = 'drift';
  if (request.reportsOff) return result;
  if (Date.now() - lastAlertAt < ALERT_COOLDOWN_MS) return { ...result, cooldown: true };
  lastAlertAt = Date.now();

  const driftText = check.drift
    .map((entry) => `${entry.table} ${entry.source.toLocaleString('en-GB')} -> ${entry.target.toLocaleString('en-GB')} (${entry.delta > 0 ? '+' : ''}${entry.delta.toLocaleString('en-GB')})`)
    .join('; ');

  result.alerted = true;
  createSessionAndAlert({
    issueTitle: `Row-count drift after billing migration: ${driftText}`,
    issueUrl: '',
    culprit: 'pipelines/c0e5ab62/migrate.js',
    errorType: 'MigrationRowCountDrift',
    errorValue: `Source and target row counts differ on ${check.drift.length} of ${TABLES.length} tables: ${driftText}. The migration run reported completed.`,
    customer: 'c0e5ab62',
    devinUserId: request.devinUserId,
    devinEmail: request.devinEmail,
    devinOrgId: request.devinOrgId,
    service: 'billing-migration',
    verticalLabel: 'Vodafone \u2014 Billing migration validation',
    promptAppendix: VALIDATION_DIRECTIVE,
    tags: [
      { key: 'route', value: '/api/c0e5ab62/validate' },
      { key: 'service', value: 'billing-migration' },
      { key: 'tables_drifting', value: String(check.drift.length) },
    ],
    extra: { checkId, sourceRows: check.sourceRows, targetRows: check.targetRows, drift: check.drift },
    level: 'error',
    platform: 'node',
    firstSeen: '',
    lastSeen: result.checkedAt,
    count: '',
    shortId: '',
    project: 'event-driven-devin',
    release: process.env.SENTRY_RELEASE || 'billing-migration@1.0.0',
    environment: process.env.DD_ENV || 'prod',
    triggeredRule: '',
  }).catch((err) => {
    logger.error('Failed to trigger Devin session from migration validation', { error: err.message });
  });

  return result;
}

function resetAlertCooldown() {
  lastAlertAt = 0;
}

module.exports = {
  getDashboard, runValidation, rowCountCheck, summariseValidation, resetAlertCooldown, VALIDATION_DIRECTIVE,
};
