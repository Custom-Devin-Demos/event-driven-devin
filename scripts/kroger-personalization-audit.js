#!/usr/bin/env node
/**
 * Offer personalization coverage audit.
 *
 * Scores the live offer pool for every membership tier the storefront can send and
 * reports the resulting match rate per segment. A tier whose segment is absent from
 * the materialized feature view still returns HTTP 200 and still fills every offer
 * slot, so coverage is not observable from the serving path — this audit is what
 * makes it observable.
 *
 * Intended to run after every feature build and on a schedule against production.
 * Exits non-zero when a tier is undeclared, maps to a segment the spec and service
 * disagree on, resolves to a segment the feature view does not encode, or measures a
 * match rate of 0 despite being encoded.
 *
 * Usage: node scripts/kroger-personalization-audit.js [--json]
 *        (or npm run audit:kroger)
 */

const {
  rankOffers,
  resolveOfferSegment,
  OFFER_POOL,
  OFFER_AFFINITY_VIEW,
  MEMBERSHIP_FUEL_PROGRAM_CODES,
} = require('../app/services/verticals/eaa595e1');
const logger = require('../app/telemetry/logger');
const spec = require('../pipelines/kroger/offer-affinity-spec.json');

const encodedSegments = OFFER_AFFINITY_VIEW.segments || {};
const declaredTiers = spec.membershipTiers || {};

/**
 * Every tier the storefront can actually send, taken from the service mapping
 * rather than the spec.
 *
 * A tier the service knows about but the spec never declared is the exact drift
 * this audit exists to catch, so enumerating the spec here would skip it.
 */
function storefrontTiers() {
  return Object.keys(MEMBERSHIP_FUEL_PROGRAM_CODES);
}

/**
 * Audits one membership tier end to end through the real ranker.
 */
function auditTier(membership) {
  const segment = resolveOfferSegment(membership);
  const ranked = rankOffers(membership, OFFER_POOL.length);
  const encoded = Object.prototype.hasOwnProperty.call(encodedSegments, segment.code);

  const declared = Object.prototype.hasOwnProperty.call(declaredTiers, membership);

  return {
    membership,
    segment: segment.code,
    encoded,
    declared,
    // The spec and the service must agree on what this tier encodes to; a spec that
    // declares the tier but maps it elsewhere is still drift.
    specSegment: declared ? declaredTiers[membership] : null,
    mapsConsistently: declared && declaredTiers[membership] === segment.code,
    matchRate: ranked.matchRate,
    personalized: ranked.personalized,
    topOffer: ranked.offers.length ? ranked.offers[0].id : null,
  };
}

function main() {
  const results = storefrontTiers().map(auditTier);
  const undeclared = results.filter((row) => !row.declared);
  const mismatched = results.filter((row) => row.declared && !row.mapsConsistently);
  const uncovered = results.filter((row) => !row.encoded);
  // A segment can exist and still carry an all-zero vector, which serves the unranked
  // pool exactly like a missing one. Gate on whether anything actually scored rather than
  // on the displayed match rate, which is rounded and would read 0.00 for a large pool.
  const inert = results.filter((row) => row.encoded && !row.personalized);

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      specVersion: spec.specVersion,
      results,
      uncovered: uncovered.length,
      undeclared: undeclared.length,
      mismatched: mismatched.length,
      inert: inert.length,
    }, null, 2)}\n`);
    if (uncovered.length || undeclared.length || mismatched.length || inert.length) {
      process.exitCode = 1;
    }
    return;
  }

  // The whole report goes to stdout as a single ordered write. Splitting the table and the
  // diagnostics across stdout/stderr lets them interleave out of order once either stream is
  // a pipe, which is exactly how this gets run in CI and during the demo.
  const lines = [`Offer personalization coverage — feature view @ ${OFFER_AFFINITY_VIEW.specVersion}`, ''];

  results.forEach((row) => {
    const healthy = row.encoded && row.declared && row.mapsConsistently && row.personalized;
    lines.push(
      `  ${healthy ? 'OK  ' : 'GAP '} ${row.membership.padEnd(14)} segment=${row.segment.padEnd(14)} `
      + `match_rate=${row.matchRate.toFixed(2)} personalized=${row.personalized}`,
    );
  });
  lines.push('');

  undeclared.forEach((row) => {
    lines.push(
      `FAIL: membership "${row.membership}" is served by the storefront but is not declared in `
      + `${spec.featureView}'s membershipTiers, so the feature build never sees it.`,
    );
  });

  mismatched.forEach((row) => {
    lines.push(
      `FAIL: membership "${row.membership}" encodes to "${row.segment}" in the service but is `
      + `declared as "${row.specSegment}" in the spec. The feature view is built for the wrong segment.`,
    );
  });

  uncovered.forEach((row) => {
    lines.push(
      `FAIL: membership "${row.membership}" encodes to segment "${row.segment}", which `
      + `${spec.featureView} does not carry. Every offer scores 0 and the storefront serves `
      + 'the unranked pool with no error.',
    );
  });

  inert.forEach((row) => {
    lines.push(
      `FAIL: membership "${row.membership}" resolves to segment "${row.segment}", which is `
      + 'encoded but contributes no affinity — every offer still scores 0. A present segment '
      + 'with an all-zero vector degrades exactly like a missing one.',
    );
  });

  const unpersonalized = new Set([...uncovered, ...inert].map((row) => row.membership));

  if (unpersonalized.size) {
    lines.push(
      '',
      `${unpersonalized.size} of ${results.length} tiers are silently unpersonalized. `
      + 'Add or populate the segment(s) in pipelines/kroger/offer-affinity-spec.json and rebuild.',
    );
  }

  if (!unpersonalized.size && !undeclared.length && !mismatched.length) {
    lines.push(`All ${results.length} membership tiers resolve to an encoded segment.`);
  } else {
    // Set exitCode rather than exit() so the report is not truncated when piped.
    process.exitCode = 1;
  }

  process.stdout.write(`${lines.join('\n')}\n`);
}

if (require.main === module) {
  // The ranker logs one structured line per tier, which buries the coverage table this
  // script exists to print. Quiet it for the CLI only, so importing the exports does not
  // reconfigure the shared logger singleton. Still overridable via LOG_LEVEL.
  logger.level = process.env.LOG_LEVEL || 'error';
  main();
}

module.exports = { auditTier, storefrontTiers };
