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
 * Exits non-zero when any tier resolves to a segment the feature view does not encode.
 *
 * Usage: node scripts/kroger-personalization-audit.js [--json]
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

  return {
    membership,
    segment: segment.code,
    encoded,
    declared: Object.prototype.hasOwnProperty.call(spec.membershipTiers, membership),
    matchRate: ranked.matchRate,
    personalized: ranked.personalized,
    topOffer: ranked.offers.length ? ranked.offers[0].id : null,
  };
}

function main() {
  const results = storefrontTiers().map(auditTier);
  const uncovered = results.filter((row) => !row.encoded);
  const undeclared = results.filter((row) => !row.declared);

  if (process.argv.includes('--json')) {
    process.stdout.write(`${JSON.stringify({
      specVersion: spec.specVersion,
      results,
      uncovered: uncovered.length,
      undeclared: undeclared.length,
    }, null, 2)}\n`);
  } else {
    process.stdout.write(`Offer personalization coverage — feature view @ ${OFFER_AFFINITY_VIEW.specVersion}\n\n`);
    results.forEach((row) => {
      const verdict = row.encoded ? 'OK  ' : 'GAP ';
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

  uncovered.forEach((row) => {
    process.stderr.write(
      `FAIL: membership "${row.membership}" encodes to segment "${row.segment}", which `
      + `${spec.featureView} does not carry. Every offer scores 0 and the storefront serves `
      + 'the unranked pool with no error.\n',
    );
  });

  if (uncovered.length) {
    process.stderr.write(
      `\n${uncovered.length} of ${results.length} tiers are silently unpersonalized. `
      + 'Add the missing segment(s) to pipelines/kroger/offer-affinity-spec.json and rebuild.\n',
    );
  }

  if (uncovered.length || undeclared.length) {
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
