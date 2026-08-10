const { v4: uuidv4 } = require('uuid');
const logger = require('../../telemetry/logger');
const { incrementMetric, recordMetric, recordTiming } = require('../../telemetry/datadog');
const { Sentry } = require('../../telemetry/sentry');
const { createSessionAndAlert } = require('../devin-session');
const FEED_CONTRACT = require('./features/da6578ee-feed-contract.json');

/**
 * Wave-3 feed jobs shown on the migration console. Every job publishes into the same
 * Delta target; they differ in which legacy handler produced the batch.
 */
const FEED_JOBS = [
  {
    id: 'CIQ-PX-EOD',
    name: 'Capital IQ — EOD Pricing',
    legacySystem: 'ciq-feedhandler (Informatica + PL/SQL)',
    target: 'mi_lakehouse.silver.security_pricing',
    schedule: '22:15 UTC daily',
    status: 'cutover',
  },
  {
    id: 'SNL-FIG-PX',
    name: 'SNL FIG — Fixed Income Quotes',
    legacySystem: 'snl-fig-loader (SQL Server SSIS)',
    target: 'mi_lakehouse.silver.security_pricing',
    schedule: '23:00 UTC daily',
    status: 'cutover',
  },
  {
    id: 'IHSM-CORPACT',
    name: 'IHS Markit — Corporate Actions',
    legacySystem: 'markit-ca-batch (Perl + Sybase)',
    target: 'mi_lakehouse.silver.corporate_actions',
    schedule: '04:30 UTC daily',
    status: 'in-migration',
  },
  {
    id: 'VA-EST-CONS',
    name: 'Visible Alpha — Consensus Estimates',
    legacySystem: 'va-estimates-etl (pandas batch)',
    target: 'mi_lakehouse.silver.consensus_estimates',
    schedule: '06:00 UTC daily',
    status: 'queued',
  },
];

/**
 * Maps the legacy feed's instrument-type code onto the internal contract code the
 * lakehouse migration keys its field mappings by.
 *
 * `depositary_receipt` arrived with the wave-3 ADR onboarding.
 */
const LEGACY_INSTRUMENT_CLASS_CODES = {
  common_stock: 'equity_common',
  preferred_stock: 'equity_preferred',
  corporate_bond: 'fixed_income_corp',
  depositary_receipt: 'equity_adr',
};

/**
 * Price scales the legacy feed handler applies per instrument class, transcribed from
 * the handler's own lookup table. The migrated path reads its scale from the built
 * contract instead; parity exists to prove the two agree.
 */
const LEGACY_PRICE_SCALES = {
  common_stock: 1,
  preferred_stock: 1,
  corporate_bond: 0.01,
  depositary_receipt: 1,
};

/**
 * Daily published row counts per instrument class, from feed operations. Used to size
 * the blast radius of a class that drops out of the comparison population.
 */
const DAILY_ROW_COUNTS = {
  common_stock: 41822300,
  preferred_stock: 3104900,
  corporate_bond: 12660400,
  depositary_receipt: 2140880,
};

/**
 * One trading day's sample of the legacy feed record, as read off the wire before
 * either handler normalizes it.
 */
const SAMPLE_BATCH = [
  { securityId: 'IQ-4295903128', instrumentClass: 'common_stock', rawPrice: 512.44, currency: 'USD', volume: 3821400, caFactor: 1 },
  { securityId: 'IQ-4295905573', instrumentClass: 'common_stock', rawPrice: 187.09, currency: 'USD', volume: 21044900, caFactor: 1 },
  { securityId: 'IQ-4295858021', instrumentClass: 'common_stock', rawPrice: 94.62, currency: 'GBP', volume: 1180200, caFactor: 0.5 },
  { securityId: 'IQ-4298110977', instrumentClass: 'preferred_stock', rawPrice: 25.18, currency: 'USD', volume: 41200, caFactor: 1 },
  { securityId: 'IQ-4298114402', instrumentClass: 'preferred_stock', rawPrice: 24.05, currency: 'USD', volume: 18700, caFactor: 1 },
  { securityId: 'SNL-US912828U816', instrumentClass: 'corporate_bond', rawPrice: 9840, currency: 'USD', volume: 12500000, caFactor: 1 },
  { securityId: 'SNL-XS2434567890', instrumentClass: 'corporate_bond', rawPrice: 10125, currency: 'EUR', volume: 4000000, caFactor: 1 },
  { securityId: 'IQ-ADR-4295864818', instrumentClass: 'depositary_receipt', rawPrice: 63.71, currency: 'USD', volume: 2244100, caFactor: 1 },
  { securityId: 'IQ-ADR-4295900012', instrumentClass: 'depositary_receipt', rawPrice: 41.86, currency: 'USD', volume: 876500, caFactor: 1 },
];

/**
 * Resolves a legacy instrument-type code to its contract code, ignoring anything
 * inherited from Object.prototype.
 */
function resolveContractCode(instrumentClass) {
  return Object.prototype.hasOwnProperty.call(LEGACY_INSTRUMENT_CLASS_CODES, instrumentClass)
    ? LEGACY_INSTRUMENT_CLASS_CODES[instrumentClass]
    : null;
}

/**
 * Resolves the field contract the migrated publisher writes an instrument class with.
 *
 * Classes the built contract does not carry resolve to undefined; callers decide
 * whether that is fatal.
 */
function resolveFeedContract(instrumentClass) {
  const code = resolveContractCode(instrumentClass);
  const contracts = FEED_CONTRACT.contracts || {};
  const contract = code && Object.prototype.hasOwnProperty.call(contracts, code)
    ? contracts[code]
    : undefined;
  return { code, contract, mapped: Boolean(contract) };
}

/**
 * Normalizes one record the way the legacy feed handler does, as the parity baseline.
 */
function normalizeLegacyRow(row) {
  const scale = LEGACY_PRICE_SCALES[row.instrumentClass];
  return {
    security_id: row.securityId,
    price_close: Math.round(row.rawPrice * scale * row.caFactor * 10000) / 10000,
    price_currency: row.currency,
    volume: row.volume,
    corporate_action_factor: row.caFactor,
  };
}

/**
 * Normalizes one record the way the migrated PySpark path does, driven by the built
 * field contract rather than a hard-coded lookup.
 */
function normalizeMigratedRow(row) {
  const { contract } = resolveFeedContract(row.instrumentClass);
  return {
    security_id: row.securityId,
    price_close: Math.round(row.rawPrice * contract.priceScale * row.caFactor * 10000) / 10000,
    price_currency: row.currency,
    volume: row.volume,
    corporate_action_factor: row.caFactor,
  };
}

/**
 * Compares one legacy row against its migrated counterpart column by column.
 */
function diffRow(legacyRow, migratedRow) {
  return Object.keys(legacyRow).filter((column) => legacyRow[column] !== migratedRow[column]);
}

/**
 * Runs the data-parity harness over a batch: legacy output vs. migrated output, row
 * count, and column-level diffs.
 *
 * Rows whose instrument class the field contract does not carry cannot be normalized by
 * the migrated path, so they are held out of the comparison population and reported
 * separately as uncovered.
 */
function runParityCheck(batch = SAMPLE_BATCH) {
  const compared = [];
  const excluded = [];

  batch.forEach((row) => {
    const { code, mapped } = resolveFeedContract(row.instrumentClass);

    if (!mapped) {
      excluded.push({ securityId: row.securityId, instrumentClass: row.instrumentClass, contractCode: code });
      return;
    }

    const legacyRow = normalizeLegacyRow(row);
    const migratedRow = normalizeMigratedRow(row);
    compared.push({
      securityId: row.securityId,
      instrumentClass: row.instrumentClass,
      legacy: legacyRow,
      migrated: migratedRow,
      mismatchedColumns: diffRow(legacyRow, migratedRow),
    });
  });

  const mismatches = compared.filter((result) => result.mismatchedColumns.length > 0);
  const matchRate = compared.length ? (compared.length - mismatches.length) / compared.length : 0;
  const coverage = batch.length ? compared.length / batch.length : 0;
  const excludedClasses = [...new Set(excluded.map((row) => row.instrumentClass))];
  const excludedDailyRows = excludedClasses.reduce((sum, cls) => sum + (DAILY_ROW_COUNTS[cls] || 0), 0);

  recordMetric('feed.parity_match_rate', matchRate, {
    route: '/api/da6578ee/parity',
    wave: FEED_CONTRACT.migrationWave,
  });
  recordMetric('feed.parity_coverage', coverage, {
    route: '/api/da6578ee/parity',
    wave: FEED_CONTRACT.migrationWave,
  });
  if (excluded.length) {
    incrementMetric('feed.rows_excluded_from_parity', {
      route: '/api/da6578ee/parity',
      wave: FEED_CONTRACT.migrationWave,
    });
  }

  logger.info('Ran feed migration parity check', {
    wave: FEED_CONTRACT.migrationWave,
    specVersion: FEED_CONTRACT.specVersion,
    rowsIn: batch.length,
    rowsCompared: compared.length,
    rowsExcluded: excluded.length,
    matchRate,
    coverage,
    service: 'mi-feed-migration',
    route: '/api/da6578ee/parity',
  });

  return {
    wave: FEED_CONTRACT.migrationWave,
    specVersion: FEED_CONTRACT.specVersion,
    targetTable: FEED_CONTRACT.targetTable,
    rowsIn: batch.length,
    rowsCompared: compared.length,
    rowsExcluded: excluded.length,
    matchRate: Math.round(matchRate * 10000) / 10000,
    coverage: Math.round(coverage * 10000) / 10000,
    mismatchedColumns: mismatches.flatMap((result) => result.mismatchedColumns),
    excludedClasses,
    excludedDailyRows,
    results: compared,
    excluded,
  };
}

/**
 * The publish crash is the loud half of this defect. The same instrument-class mapping
 * drives the parity harness, where a class the contract never carried is held out of the
 * comparison population instead of failing it — so the migration reports 100% parity on
 * the rows it chose to look at. The triage session is pointed at the pipeline that
 * produced the gap rather than the publisher that hit it.
 */
const PARITY_DIRECTIVE = [
  '*The crash is the cheap half of this defect. Check what parity is not comparing.*',
  '',
  '`LEGACY_INSTRUMENT_CLASS_CODES` in `app/services/verticals/da6578ee.js` has two consumers. `normalizeMigratedRow()` dereferences the resolved field contract and throws — that is the alert you are looking at. `runParityCheck()` resolves the same code, finds no contract, and *holds those rows out of the comparison population* rather than failing them. The harness then divides matches by the rows it kept, so it reports `parity_match_rate = 1.0` while an entire instrument class never lands in Delta. No exception, no alert: the only signal is `feed.parity_coverage` on `GET /api/da6578ee/parity` sitting below 1.0.',
  '',
  'A migration that reports 100% parity on a subset it silently chose is worse than one that reports a failure. This is the number a client sees in Capital IQ.',
  '',
  'The serving code is not where this originates. `pipelines/spgi/feed-mapping-spec.json` is the source of truth for instrument-class mapping, and `pipelines/spgi/build-feed-contract.js` materializes it into `app/services/verticals/features/da6578ee-feed-contract.json`. A class declared in `instrumentClasses` with no matching entry under `contracts` builds clean and ships a contract that cannot publish that class at all.',
  '',
  'Run `npm run audit:spgi` first — it drives every instrument class the publisher can emit through the real parity harness and will show you the gap and its blast radius before you change anything.',
  '',
  'Then fix it as a data problem, not a serving problem:',
  '1. Register the missing instrument class in the mapping spec and rebuild the contract (do not hand-edit the built artifact).',
  '2. Make the build fail on this class of defect — an instrument class that maps onto a contract the spec does not carry should break `build-feed-contract.js`, not reach production.',
  '3. Make the parity harness fail closed: an uncovered row is a parity failure, not an exclusion. Report coverage alongside match rate so a 100% match on a partial population is impossible to read as green.',
  '4. Fix the publish crash at the same root cause, and add regression coverage for the silent path as well as the throwing one.',
  '',
  'Call out in your PR how many rows per day were dropping out of the comparison, and how long the migration could have run reporting full parity while doing it.',
].join('\n');

/**
 * Publishes a normalized batch from the legacy feed into the Delta target.
 */
async function publishFeedBatch(publishData) {
  const startTime = Date.now();
  const runId = uuidv4();
  const batch = publishData.batch && publishData.batch.length ? publishData.batch : SAMPLE_BATCH;

  logger.info('Publishing migrated feed batch', {
    runId,
    jobId: publishData.jobId,
    asOfDate: publishData.asOfDate,
    rows: batch.length,
    service: 'mi-feed-migration',
    route: '/api/da6578ee/publish',
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 80 + Math.random() * 120));

    const rows = batch.map(normalizeMigratedRow);
    const parity = runParityCheck(batch);
    const duration = Date.now() - startTime;

    incrementMetric('feed.publish_success', {
      route: '/api/da6578ee/publish',
      source: 'mi-feed-migration',
    });
    recordTiming('feed.publish_latency', duration, {
      route: '/api/da6578ee/publish',
    });

    return {
      success: true,
      runId,
      jobId: publishData.jobId,
      asOfDate: publishData.asOfDate,
      targetTable: FEED_CONTRACT.targetTable,
      specVersion: FEED_CONTRACT.specVersion,
      rowsPublished: rows.length,
      parity: {
        matchRate: parity.matchRate,
        coverage: parity.coverage,
        rowsCompared: parity.rowsCompared,
        rowsExcluded: parity.rowsExcluded,
      },
      publishedAt: new Date().toISOString(),
    };
  } catch (error) {
    const duration = Date.now() - startTime;

    incrementMetric('feed.publish_failure', {
      route: '/api/da6578ee/publish',
      errorClass: error.name,
      source: 'mi-feed-migration',
    });
    recordTiming('feed.publish_latency', duration, {
      route: '/api/da6578ee/publish',
      error: 'true',
    });

    logger.error('Migrated feed publish failed', {
      runId,
      error: error.message,
      errorClass: error.name,
      durationMs: duration,
      jobId: publishData.jobId,
      asOfDate: publishData.asOfDate,
      service: 'mi-feed-migration',
    });

    Sentry.captureException(error, {
      tags: {
        route: '/api/da6578ee/publish',
        service: 'mi-feed-migration',
        source: 'mi-feed-migration',
      },
      extra: {
        runId,
        jobId: publishData.jobId,
        asOfDate: publishData.asOfDate,
        targetTable: FEED_CONTRACT.targetTable,
        specVersion: FEED_CONTRACT.specVersion,
        rows: batch.length,
      },
    });

    createSessionAndAlert({
      issueTitle: `${error.name}: ${error.message}`,
      issueUrl: `https://${process.env.SENTRY_ORG_SLUG || 'sentry-org'}.sentry.io/issues/?project=${process.env.SENTRY_PROJECT_ID || ''}&query=is%3Aunresolved`,
      culprit: 'app/services/verticals/da6578ee.js \u2014 normalizeMigratedRow',
      errorType: error.name || 'Error',
      errorValue: error.message,
      customer: 'da6578ee',
      devinUserId: publishData.devinUserId,
      devinEmail: publishData.devinEmail,
      devinOrgId: publishData.devinOrgId,
      service: 'mi-feed-migration',
      verticalLabel: 'S&P Global Market Intelligence \u2014 Feed Migration',
      promptAppendix: PARITY_DIRECTIVE,
      tags: [
        { key: 'route', value: '/api/da6578ee/publish' },
        { key: 'service', value: 'mi-feed-migration' },
        { key: 'job_id', value: String(publishData.jobId) },
        { key: 'migration_wave', value: String(FEED_CONTRACT.migrationWave) },
      ],
      extra: {
        runId,
        jobId: publishData.jobId,
        asOfDate: publishData.asOfDate,
        targetTable: FEED_CONTRACT.targetTable,
        rows: batch.length,
      },
      level: 'error',
      platform: 'node',
      firstSeen: '',
      lastSeen: new Date().toISOString(),
      count: '',
      shortId: '',
      project: 'event-driven-devin',
      release: process.env.SENTRY_RELEASE || 'mi-feed-migration@1.0.0',
      environment: process.env.DD_ENV || 'prod',
      triggeredRule: '',
    }).catch((err) => {
      logger.error('Failed to trigger Devin session from feed publish error', { error: err.message });
    });

    throw error;
  }
}

module.exports = {
  publishFeedBatch,
  runParityCheck,
  resolveFeedContract,
  resolveContractCode,
  normalizeLegacyRow,
  normalizeMigratedRow,
  diffRow,
  PARITY_DIRECTIVE,
  FEED_JOBS,
  FEED_CONTRACT,
  LEGACY_INSTRUMENT_CLASS_CODES,
  LEGACY_PRICE_SCALES,
  DAILY_ROW_COUNTS,
  SAMPLE_BATCH,
};
