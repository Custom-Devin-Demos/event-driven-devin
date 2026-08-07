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
 * Usage: npm run audit:kroger [-- --json]
 */

const {
  rankOffers,
  resolveOfferSegment,
  OFFER_POOL,
  OFFER_AFFINITY_VIEW,
  MEMBERSHIP_FUEL_PROGRAM_CODES,
} = require('../app/services/verticals/eaa595e1');
const spec = require('../pipelines/kroger/offer-affinity-spec.json');

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
  const encoded = Object.prototype.hasOwnProperty.call(OFFER_AFFINITY_VIEW.segments, segment.code);

  const declared = Object.prototype.hasOwnProperty.call(spec.membershipTiers, membership);

  return {
    membership,
    segment: segment.code,
    encoded,
    declared,
    // The spec and the service must agree on what this tier encodes to; a spec that
    // declares the tier but maps it elsewhere is still drift.
    specSegment: declared ? spec.membershipTiers[membership] : null,
    mapsConsistently: declared && spec.membershipTiers[membership] === segment.code,
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
  } else {
    process.stdout.write(`Offer personalization coverage — feature view @ ${OFFER_AFFINITY_VIEW.specVersion}\n\n`);
    results.forEach((row) => {
      const healthy = row.encoded && row.declared && row.mapsConsistently && row.personalized;
      const verdict = healthy ? 'OK  ' : 'GAP ';
      process.stdout.write(
        `  ${verdict} ${row.membership.padEnd(14)} segment=${row.segment.padEnd(14)} `
        + `match_rate=${row.matchRate.toFixed(2)} personalized=${row.personalized}\n`,
      );
    });
    process.stdout.write('\n');
  }

  undeclared.forEach((row) => {
    process.stderr.write(
      `FAIL: membership "${row.membership}" is served by the storefront but is not declared in `
      + `${spec.featureView}'s membershipTiers, so the feature build never sees it.\n`,
    );
  });

  mismatched.forEach((row) => {
    process.stderr.write(
      `FAIL: membership "${row.membership}" encodes to "${row.segment}" in the service but is `
      + `declared as "${row.specSegment}" in the spec. The feature view is built for the wrong segment.\n`,
    );
  });

  uncovered.forEach((row) => {
    process.stderr.write(
      `FAIL: membership "${row.membership}" encodes to segment "${row.segment}", which `
      + `${spec.featureView} does not carry. Every offer scores 0 and the storefront serves `
      + 'the unranked pool with no error.\n',
    );
  });

  inert.forEach((row) => {
    process.stderr.write(
      `FAIL: membership "${row.membership}" resolves to segment "${row.segment}", which is `
      + 'encoded but contributes no affinity — every offer still scores 0. A present segment '
      + 'with an all-zero vector degrades exactly like a missing one.\n',
    );
  });

  const unpersonalized = new Set([...uncovered, ...inert].map((row) => row.membership));

  if (unpersonalized.size) {
    process.stderr.write(
      `\n${unpersonalized.size} of ${results.length} tiers are silently unpersonalized. `
      + 'Add or populate the segment(s) in pipelines/kroger/offer-affinity-spec.json and rebuild.\n',
    );
  }

  if (unpersonalized.size || undeclared.length || mismatched.length) {
    // Set exitCode rather than exit() so the table above is not truncated when piped.
    process.exitCode = 1;
    return;
  }

  process.stdout.write(`All ${results.length} membership tiers resolve to an encoded segment.\n`);
}

if (require.main === module) {
  main();
}

module.exports = { auditTier, storefrontTiers };
