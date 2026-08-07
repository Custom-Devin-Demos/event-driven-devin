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
  if (!segment.weights || typeof segment.weights !== 'object') {
    throw new Error(`Segment "${code}" declares no weights object — a segment that cannot be encoded must fail the build, not ship as a zero vector.`);
  }

  const vector = {};
  vocabulary.forEach((category) => {
    const weight = segment.weights[category];
    vector[category] = typeof weight === 'number' ? weight : 0;
  });
  return vector;
}

/**
 * Builds the materialized feature view from the affinity spec.
 */
function buildFeatureView(spec) {
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
  return JSON.parse(fs.readFileSync(SPEC_PATH, 'utf8'));
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
      process.exit(1);
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
  main();
}

module.exports = {
  buildFeatureView, encodeSegment, readSpec, serialize, SPEC_PATH, ARTIFACT_PATH,
};
