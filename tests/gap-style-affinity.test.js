jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

const {
  rankOffers,
  resolveStyleSegment,
  computeRewardsPoints,
  OFFER_POOL,
  STYLE_AFFINITY_VIEW,
  MEMBERSHIP_PROGRAM_CODES,
} = require('../app/services/verticals/383b99d1');

const fs = require('fs');

const {
  buildFeatureView, encodeSegment, readSpec, serialize, ARTIFACT_PATH,
} = require('../pipelines/gap/build-style-features');
const { auditTier, storefrontTiers } = require('../scripts/gap-personalization-audit');

const spec = readSpec();

describe('style-affinity feature build', () => {
  test('encodes every segment as a dense vector over the style vocabulary', () => {
    const view = buildFeatureView(spec);

    Object.values(view.segments).forEach((vector) => {
      expect(Object.keys(vector)).toEqual(spec.styleVocabulary);
    });
  });

  test('fails the build when a segment declares no weights rather than shipping a zero vector', () => {
    expect(() => encodeSegment({ cohortSize: 100 }, ['denim'], 'gr_icon'))
      .toThrow(/gr_icon.*no weights/);
  });

  test('fails legibly on a malformed spec rather than throwing a raw TypeError', () => {
    expect(() => buildFeatureView({ segments: {} })).toThrow(/styleVocabulary/);
    expect(() => buildFeatureView({ styleVocabulary: ['denim'] })).toThrow(/segments/);
    expect(() => buildFeatureView({ styleVocabulary: ['denim'], segments: { gr_icon: null } }))
      .toThrow(/gr_icon.*not an object/);
  });

  test('rejects weights outside the normalized [0,1] range instead of materializing them', () => {
    [-0.4, 1.4, NaN, Infinity].forEach((weight) => {
      expect(() => encodeSegment({ weights: { denim: weight } }, ['denim'], 'gr_enrolled'))
        .toThrow(/gr_enrolled.*denim.*\[0,1\]/);
    });
  });

  test('rejects weights keyed to styles outside the vocabulary instead of dropping them', () => {
    expect(() => encodeSegment({ weights: { denim: 0.5, tee: 0.6 } }, ['denim', 'tees'], 'gr_enrolled'))
      .toThrow(/gr_enrolled.*"tee".*vocabulary/);
  });

  test('names the offending non-finite value instead of rendering it as null', () => {
    expect(() => encodeSegment({ weights: { denim: NaN } }, ['denim'], 'gr_enrolled'))
      .toThrow(/weight NaN for style "denim"/);
    expect(() => encodeSegment({ weights: { denim: Infinity } }, ['denim'], 'gr_enrolled'))
      .toThrow(/weight Infinity for style "denim"/);
  });

  test('rounds encoded weights to the 2dp the spec documents', () => {
    expect(encodeSegment({ weights: { denim: 0.4449 } }, ['denim'])).toEqual({ denim: 0.44 });
  });

  test('encodes a style the segment has no purchase history for as 0, not undefined', () => {
    const vector = encodeSegment({ weights: { denim: 0.5 } }, ['denim', 'kids']);

    expect(vector).toEqual({ denim: 0.5, kids: 0 });
  });

  test('committed artifact matches a fresh build of the spec', () => {
    expect(buildFeatureView(spec)).toEqual(STYLE_AFFINITY_VIEW);
  });

  test('committed artifact is byte-identical to a fresh build, so a hand-edit fails the suite', () => {
    expect(fs.readFileSync(ARTIFACT_PATH, 'utf8')).toBe(serialize(buildFeatureView(spec)));
  });
});

describe('offer ranking', () => {
  test('personalizes a tier the feature view encodes, ranked by descending affinity', () => {
    const result = rankOffers('enrolled', OFFER_POOL.length);
    const scores = result.offers.map((offer) => offer.score);

    expect(result.segment).toBe('gr_enrolled');
    expect(result.segmentEncoded).toBe(true);
    expect(result.personalized).toBe(true);
    expect(result.matchRate).toBe(1);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test('serves the unranked pool without throwing when the feature view has no vector for the segment', () => {
    const result = rankOffers('icon', OFFER_POOL.length);

    expect(result.segment).toBe('gr_icon');
    // Distinguishes "absent from the feature view" from "present but inert", which
    // the storefront reports differently even though they serve identically.
    expect(result.segmentEncoded).toBe(false);
    expect(result.personalized).toBe(false);
    expect(result.matchRate).toBe(0);
    expect(result.offers).toHaveLength(OFFER_POOL.length);
    expect(result.offers.every((offer) => offer.score === 0)).toBe(true);
  });

  test('fills every slot for a segment the feature view only partially covers', () => {
    // Partial coverage is what a half-finished fix produces, and it must not surface
    // as a short grid — that is a degradation mode the audit does not watch for.
    const original = Object.getOwnPropertyDescriptor(STYLE_AFFINITY_VIEW.segments, 'gr_icon');
    try {
      STYLE_AFFINITY_VIEW.segments.gr_icon = { denim: 0.7, outerwear: 0.9 };
      const result = rankOffers('icon', 4);

      expect(result.personalized).toBe(true);
      expect(result.offers).toHaveLength(4);
      // Scored offers rank first, in descending order; the rest backfill behind them.
      expect(result.offers.map((offer) => offer.score)).toEqual([0.9, 0.7, 0, 0]);
      // Partial coverage is the only case that yields a match rate strictly between
      // 0 and 1, which the rounded response reports as 0.33 of the 6-offer pool.
      expect(result.matchRate).toBe(0.33);
    } finally {
      if (original) {
        Object.defineProperty(STYLE_AFFINITY_VIEW.segments, 'gr_icon', original);
      } else {
        delete STYLE_AFFINITY_VIEW.segments.gr_icon;
      }
    }
  });

  test('treats a segment entry that carries no style keys as unencoded', () => {
    // Only reachable by hand-editing the artifact past the build; the point is that
    // scoring it degrades silently rather than throwing, and reports the honest reason.
    // The view is require-cached and shared, and gr_icon stops being absent the
    // moment the planted gap is fixed — so restore whatever was there, don't delete.
    const original = Object.getOwnPropertyDescriptor(STYLE_AFFINITY_VIEW.segments, 'gr_icon');
    try {
      [[], 'gr_icon', 7].forEach((entry) => {
        STYLE_AFFINITY_VIEW.segments.gr_icon = entry;
        expect(resolveStyleSegment('icon').encoded).toBe(false);
        expect(rankOffers('icon').personalized).toBe(false);
      });
    } finally {
      if (original) {
        Object.defineProperty(STYLE_AFFINITY_VIEW.segments, 'gr_icon', original);
      } else {
        delete STYLE_AFFINITY_VIEW.segments.gr_icon;
      }
    }
  });

  test('resolves inherited Object.prototype keys to the core segment', () => {
    ['constructor', 'toString', 'hasOwnProperty'].forEach((membership) => {
      expect(resolveStyleSegment(membership).code).toBe('gr_core');
    });
  });
});

describe('personalization coverage audit', () => {
  test('audits the tiers the storefront can send, not the ones the spec happens to declare', () => {
    expect(storefrontTiers()).toEqual(Object.keys(MEMBERSHIP_PROGRAM_CODES));
  });

  test('flags a tier the service serves but the spec never declared', () => {
    const row = auditTier('navyist');

    expect(row.declared).toBe(false);
    expect(row.segment).toBe('gr_core');
  });

  test('confirms the spec and the service agree on what each declared tier encodes to', () => {
    storefrontTiers().filter((tier) => spec.membershipTiers[tier]).forEach((tier) => {
      expect(auditTier(tier).mapsConsistently).toBe(true);
    });
  });

  test('flags every membership tier the feature view cannot personalize', () => {
    const uncovered = storefrontTiers()
      .map(auditTier)
      .filter((row) => !row.encoded);

    expect(uncovered.map((row) => row.membership)).toEqual(['icon']);
    expect(uncovered[0].matchRate).toBe(0);
    expect(uncovered[0].personalized).toBe(false);
  });

  test('the uncovered tier is the same one that crashes checkout', () => {
    expect(() => computeRewardsPoints(42.5, 'icon')).toThrow(/pointsPerDollar/);
    expect(computeRewardsPoints(42.5, 'enrolled').points).toBe(84);
  });
});
