#!/usr/bin/env node
/**
 * Offer-affinity feature build.
 *
 * Encodes each shopper segment declared in the affinity spec as a dense vector over
 * the offer category vocabulary and writes the materialized feature view the
 * storefront ranker loads at request time.
 *
 * Run whenever the spec changes; the emitted artifact is committed so the serving
 * path never depends on the pipeline being available.
 *
 * Usage: node pipelines/kroger/build-offer-features.js [--check]
 *
 *   --check  Rebuild in memory and exit non-zero if the committed artifact is stale.
 */

const fs = require('fs');
const path = require('path');

const SPEC_PATH = path.join(__dirname, 'offer-affinity-spec.json');
const ARTIFACT_PATH = path.join(
  __dirname, '..', '..', 'app', 'services', 'verticals', 'features', 'eaa595e1-offer-affinity.json',
);

/**
 * Encodes one segment's weights as a dense vector over the category vocabulary.
 *
 * Categories the segment carries no basket history for encode as 0, which the ranker
 * reads as "no affinity" rather than "unknown".
 */
function encodeSegment(segment, vocabulary, code = 'segment') {
  if (!segment || typeof segment !== 'object') {
    throw new Error(`Segment "${code}" is not an object — the spec entry is malformed and cannot be encoded.`);
  }
  if (!segment.weights || typeof segment.weights !== 'object') {
    throw new Error(`Segment "${code}" declares no weights object — a segment that cannot be encoded must fail the build, not ship as a zero vector.`);
  }

  // A weight keyed to a category outside the vocabulary is never read by the encoding
  // loop below, so it would be dropped without trace and the category would serve as
  // "no affinity" — a typo like "groceries" degrades exactly like the missing segment
  // this pipeline exists to catch.
  const known = new Set(vocabulary);
  const unknown = Object.keys(segment.weights).filter((category) => !known.has(category));
  if (unknown.length) {
    throw new Error(
      `Segment "${code}" declares weights for ${unknown.map((c) => `"${c}"`).join(', ')}, which `
      + 'the category vocabulary does not contain — the weights would be silently dropped. '
      + 'Fix the category name or add it to categoryVocabulary.',
    );
  }

  const vector = {};
  vocabulary.forEach((category) => {
    const weight = segment.weights[category];

    if (weight === undefined) {
      vector[category] = 0;
      return;
    }

    // Weights are a basket-share index normalized to [0,1]. A negative or non-finite
    // weight survives serialization but is indistinguishable from "no affinity" once the
    // ranker filters on score > 0, so it degrades silently instead of failing here.
    if (!Number.isFinite(weight) || weight < 0 || weight > 1) {
      throw new Error(
        // String() rather than JSON.stringify(), which renders both NaN and Infinity
        // as "null" and hides the value the author actually wrote.
        `Segment "${code}" declares weight ${String(weight)} for category "${category}" — `
        + 'weights must be finite numbers in [0,1].',
      );
    }

    // Rounded here rather than trusted from the spec, so the 2dp precision the spec
    // documents is a property of the build instead of a convention authors must remember.
    vector[category] = Math.round(weight * 100) / 100;
  });
  return vector;
}

/**
 * Builds the materialized feature view from the affinity spec.
 */
function buildFeatureView(spec) {
  if (!Array.isArray(spec.categoryVocabulary)) {
    throw new Error('Spec declares no categoryVocabulary array — there is nothing to encode segments over.');
  }
  if (!spec.segments || typeof spec.segments !== 'object') {
    throw new Error('Spec declares no segments object — the feature view would ship with no coverage at all.');
  }

  const segments = {};

  Object.keys(spec.segments).forEach((code) => {
    segments[code] = encodeSegment(spec.segments[code], spec.categoryVocabulary, code);
  });

  return {
    featureView: spec.featureView,
    specVersion: spec.specVersion,
    trainingWindow: spec.trainingWindow,
    categoryVocabulary: spec.categoryVocabulary,
    segments,
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

function serialize(featureView) {
  return `${JSON.stringify(featureView, null, 2)}\n`;
}

function main() {
  const spec = readSpec();
  const featureView = buildFeatureView(spec);
  const serialized = serialize(featureView);
  const encoded = Object.keys(featureView.segments);

  if (process.argv.includes('--check')) {
    const committed = fs.existsSync(ARTIFACT_PATH) ? fs.readFileSync(ARTIFACT_PATH, 'utf8') : '';
    if (committed !== serialized) {
      process.stderr.write(
        'Committed offer-affinity artifact does not match a fresh build of the spec — it is stale '
        + 'or was hand-edited (this comparison is byte-exact, so reformatting also fails). '
        + 'Run: npm run features:build\n',
      );
      // Set exitCode rather than exit() so buffered output survives a pipe.
      process.exitCode = 1;
      return;
    }
    process.stdout.write(`Offer-affinity artifact is up to date (${encoded.length} segments).\n`);
    return;
  }

  fs.mkdirSync(path.dirname(ARTIFACT_PATH), { recursive: true });
  fs.writeFileSync(ARTIFACT_PATH, serialized);

  process.stdout.write(
    `Built ${featureView.featureView} @ ${featureView.specVersion} — `
    + `${encoded.length} segments [${encoded.join(', ')}], `
    + `${featureView.categoryVocabulary.length} categories.\n`,
  );
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    // Every validation in this file throws a sentence written for a spec author; a raw
    // stack trace from the CLI would bury it. Callers still get the exception.
    process.stderr.write(`Feature build failed: ${err.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  buildFeatureView, encodeSegment, readSpec, serialize, SPEC_PATH, ARTIFACT_PATH,
};
