#!/usr/bin/env node
/**
 * Feed field-contract build.
 *
 * Materializes the wave-3 field-mapping spec into the contract artifact the migrated
 * pricing publisher and the parity harness both load at request time. The contract is
 * what tells the PySpark path which legacy column feeds each Delta column and what
 * price scale the legacy handler applied.
 *
 * Run whenever the spec changes; the emitted artifact is committed so the serving path
 * never depends on the pipeline being available.
 *
 * Usage: node pipelines/spgi/build-feed-contract.js [--check]
 *
 *   --check  Rebuild in memory and exit non-zero if the committed artifact is stale.
 */

const fs = require('fs');
const path = require('path');

const SPEC_PATH = path.join(__dirname, 'feed-mapping-spec.json');
const ARTIFACT_PATH = path.join(
  __dirname, '..', '..', 'app', 'services', 'verticals', 'features', 'da6578ee-feed-contract.json',
);

/**
 * Encodes one instrument class's contract as a dense mapping over the target column
 * vocabulary.
 *
 * A target column the contract carries no source field for encodes as null, which the
 * publisher reads as "not carried by this feed" and leaves unset on the Delta row.
 */
function encodeContract(contract, vocabulary, code = 'contract') {
  if (!contract || typeof contract !== 'object' || Array.isArray(contract)) {
    throw new Error(`Contract "${code}" is not an object — the spec entry is malformed and cannot be encoded.`);
  }
  if (!contract.columns || typeof contract.columns !== 'object') {
    throw new Error(`Contract "${code}" declares no columns object — a class that cannot be mapped must fail the build, not ship an empty contract.`);
  }

  // A source field keyed to a column outside the vocabulary is never read by the loop
  // below, so it would be dropped without trace and the column would publish as null —
  // a typo like "price_ccy" degrades exactly like the unmapped class this pipeline
  // exists to catch.
  const known = new Set(vocabulary);
  const unknown = Object.keys(contract.columns).filter((column) => !known.has(column));
  if (unknown.length) {
    throw new Error(
      `Contract "${code}" maps source fields onto ${unknown.map((c) => `"${c}"`).join(', ')}, which `
      + 'the target column vocabulary does not contain — the mapping would be silently dropped. '
      + 'Fix the column name or add it to columnVocabulary.',
    );
  }

  // The publisher multiplies every legacy price by this before writing. A missing or
  // non-positive scale publishes zeros or sign-flipped prices, which parity catches only
  // if the class is in the comparison population at all.
  if (!Number.isFinite(contract.priceScale) || contract.priceScale <= 0) {
    throw new Error(
      `Contract "${code}" declares price scale ${String(contract.priceScale)} — `
      + 'the scale must be a finite positive number.',
    );
  }

  const columns = {};
  vocabulary.forEach((column) => {
    const sourceField = contract.columns[column];

    if (sourceField === undefined) {
      columns[column] = null;
      return;
    }
    if (typeof sourceField !== 'string' || !sourceField.trim()) {
      throw new Error(
        `Contract "${code}" maps column "${column}" onto ${String(sourceField)} — `
        + 'source fields must be non-empty legacy field names.',
      );
    }
    columns[column] = sourceField;
  });

  return {
    sourceFeed: contract.sourceFeed || null,
    priceScale: contract.priceScale,
    dailyRowCount: contract.dailyRowCount || 0,
    columns,
  };
}

/**
 * Builds the materialized field contract from the mapping spec.
 */
function buildFeedContract(spec) {
  if (!Array.isArray(spec.columnVocabulary)) {
    throw new Error('Spec declares no columnVocabulary array — there is nothing to map source fields onto.');
  }
  if (!spec.contracts || typeof spec.contracts !== 'object') {
    throw new Error('Spec declares no contracts object — the artifact would ship with no coverage at all.');
  }

  const contracts = {};

  Object.keys(spec.contracts).forEach((code) => {
    contracts[code] = encodeContract(spec.contracts[code], spec.columnVocabulary, code);
  });

  return {
    contractView: spec.contractView,
    specVersion: spec.specVersion,
    migrationWave: spec.migrationWave,
    targetTable: spec.targetTable,
    columnVocabulary: spec.columnVocabulary,
    contracts,
  };
}

function readSpec() {
  const raw = fs.readFileSync(SPEC_PATH, 'utf8');
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Spec at ${SPEC_PATH} is not valid JSON: ${err.message}`, { cause: err });
  }
}

function serialize(contract) {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

function main() {
  const spec = readSpec();
  const contract = buildFeedContract(spec);
  const serialized = serialize(contract);
  const encoded = Object.keys(contract.contracts);

  if (process.argv.includes('--check')) {
    const committed = fs.existsSync(ARTIFACT_PATH) ? fs.readFileSync(ARTIFACT_PATH, 'utf8') : '';
    if (committed !== serialized) {
      process.stderr.write(
        'Committed feed contract does not match a fresh build of the spec — it is stale or was '
        + 'hand-edited (this comparison is byte-exact, so reformatting also fails). '
        + 'Run: npm run feed:build\n',
      );
      // Set exitCode rather than exit() so buffered output survives a pipe.
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Feed contract is up to date (${encoded.length} instrument classes).\n`);
    return;
  }

  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(ARTIFACT_PATH, serialized);

  process.stdout.write(
    `Built ${contract.contractView} @ ${contract.specVersion} — `
    + `${encoded.length} instrument classes [${encoded.join(', ')}], `
    + `${contract.columnVocabulary.length} target columns.\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // Every validation in this file throws a sentence written for a spec author; a raw
    // stack trace from the CLI would bury it. Callers still get the exception.
    process.stderr.write(`Feed contract build failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildFeedContract, encodeContract, readSpec, serialize, SPEC_PATH, ARTIFACT_PATH,
};
