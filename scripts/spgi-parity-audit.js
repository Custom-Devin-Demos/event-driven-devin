#!/usr/bin/env node
/**
 * Feed migration parity coverage audit.
 *
 * Drives every instrument class the publisher can emit through the real parity harness
 * and reports whether that class is actually in the comparison population. A class the
 * built contract does not carry is held out of parity, so the harness still reports a
 * 100% match rate and coverage is not observable from its headline number — this audit
 * is what makes it observable.
 *
 * Intended to run after every contract build and before every cutover. Exits non-zero
 * when a class is undeclared in the spec, maps to a contract the spec and service
 * disagree on, resolves to a contract the artifact does not carry, or compares no rows.
 *
 * Usage: node scripts/spgi-parity-audit.js [--json]
 *        (or npm run audit:spgi)
 */

const {
  runParityCheck,
  resolveFeedContract,
  LEGACY_INSTRUMENT_CLASS_CODES,
  DAILY_ROW_COUNTS,
  SAMPLE_BATCH,
  FEED_CONTRACT,
} = require('../app/services/verticals/da6578ee');
const logger = require('../app/telemetry/logger');
const spec = require('../pipelines/spgi/feed-mapping-spec.json');

const declaredClasses = spec.instrumentClasses || {};

/**
 * Every instrument class the feed can actually publish, taken from the service mapping
 * rather than the spec.
 *
 * A class the service knows about but the spec never declared is the exact drift this
 * audit exists to catch, so enumerating the spec here would skip it.
 */
function publishableClasses() {
  return Object.keys(LEGACY_INSTRUMENT_CLASS_CODES);
}

/**
 * Audits one instrument class end to end through the real parity harness.
 */
function auditInstrumentClass(instrumentClass) {
  const resolved = resolveFeedContract(instrumentClass);
  const rows = SAMPLE_BATCH.filter((row) => row.instrumentClass === instrumentClass);
  const parity = runParityCheck(rows);
  const declared = Object.prototype.hasOwnProperty.call(declaredClasses, instrumentClass);

  return {
    instrumentClass,
    contractCode: resolved.code,
    mapped: resolved.mapped,
    declared,
    // The spec and the service must agree on what this class maps to; a spec that
    // declares the class but points it elsewhere is still drift.
    specContractCode: declared ? declaredClasses[instrumentClass] : null,
    mapsConsistently: declared && declaredClasses[instrumentClass] === resolved.code,
    sampleRows: rows.length,
    rowsCompared: parity.rowsCompared,
    rowsExcluded: parity.rowsExcluded,
    matchRate: parity.matchRate,
    dailyRows: DAILY_ROW_COUNTS[instrumentClass] || 0,
  };
}

function main() {
  const results = publishableClasses().map(auditInstrumentClass);
  const undeclared = results.filter((row) => !row.declared);
  const mismatched = results.filter((row) => row.declared && !row.mapsConsistently);
  const unmapped = results.filter((row) => !row.mapped);
  // A class can be mapped and still contribute nothing to parity if every one of its rows
  // is held out. Gate on rows actually compared rather than on the headline match rate,
  // which reads 1.00 precisely when the population is empty of the rows that would fail.
  const uncompared = results.filter((row) => row.mapped && row.sampleRows > 0 && row.rowsCompared === 0);

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      specVersion: spec.specVersion,
      wave: spec.migrationWave,
      results,
      unmapped: unmapped.length,
      undeclared: undeclared.length,
      mismatched: mismatched.length,
      uncompared: uncompared.length,
    }, null, 2)}\n`);
    if (unmapped.length || undeclared.length || mismatched.length || uncompared.length) {
      process.exitCode = 1;
    }
    return;
  }

  // The whole report goes to stdout as a single ordered write. Splitting the table and the
  // diagnostics across stdout/stderr lets them interleave out of order once either stream
  // is a pipe, which is exactly how this gets run in CI and during a cutover.
  const lines = [
    `Feed migration parity coverage — ${spec.migrationWave}, contract @ ${FEED_CONTRACT.specVersion}`,
    '',
  ];

  results.forEach((row) => {
    const healthy = row.mapped && row.declared && row.mapsConsistently && row.rowsCompared > 0;
    lines.push(
      `  ${healthy ? 'OK  ' : 'GAP '} ${row.instrumentClass.padEnd(20)} contract=${String(row.contractCode).padEnd(18)} `
      + `compared=${row.rowsCompared}/${row.sampleRows} match_rate=${row.matchRate.toFixed(2)}`,
    );
  });
  lines.push('');

  undeclared.forEach((row) => {
    lines.push(
      `FAIL: instrument class "${row.instrumentClass}" is published by the feed but is not declared in `
      + `${spec.contractView}'s instrumentClasses, so the contract build never sees it.`,
    );
  });

  mismatched.forEach((row) => {
    lines.push(
      `FAIL: instrument class "${row.instrumentClass}" maps to "${row.contractCode}" in the service but is `
      + `declared as "${row.specContractCode}" in the spec. The contract is built for the wrong class.`,
    );
  });

  unmapped.forEach((row) => {
    lines.push(
      `FAIL: instrument class "${row.instrumentClass}" maps to contract "${row.contractCode}", which `
      + `${spec.contractView} does not carry. Its rows are held out of the parity population, so the `
      + `harness reports a full match while ~${row.dailyRows.toLocaleString('en-US')} rows/day never land in `
      + `${spec.targetTable}.`,
    );
  });

  uncompared.forEach((row) => {
    lines.push(
      `FAIL: instrument class "${row.instrumentClass}" is mapped but contributed no rows to the parity `
      + 'population. A class that is never compared is indistinguishable from one that passes.',
    );
  });

  const silent = new Set([...unmapped, ...uncompared].map((row) => row.instrumentClass));

  if (silent.size) {
    const dailyRows = [...unmapped, ...uncompared].reduce((sum, row) => sum + row.dailyRows, 0);
    lines.push(
      '',
      `${silent.size} of ${results.length} instrument classes are outside the parity population `
      + `(~${dailyRows.toLocaleString('en-US')} rows/day unverified). `
      + 'Add the class(es) to pipelines/spgi/feed-mapping-spec.json and rebuild.',
    );
  }

  if (!silent.size && !undeclared.length && !mismatched.length) {
    lines.push(`All ${results.length} instrument classes are in the parity population.`);
  } else {
    // Set exitCode rather than exit() so the report is not truncated when piped.
    process.exitCode = 1;
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

if (require.main === module) {
  // The harness logs one structured line per run, which buries the coverage table this
  // script exists to print. Quiet it for the CLI only, so importing the exports does not
  // reconfigure the shared logger singleton. Still overridable via LOG_LEVEL.
  logger.level = process.env.LOG_LEVEL || 'error';
  main();
}

module.exports = { auditInstrumentClass, publishableClasses };
