jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

const {
  rankOffers,
  resolveOfferSegment,
  computeFuelPoints,
  OFFER_POOL,
  OFFER_AFFINITY_VIEW,
  MEMBERSHIP_FUEL_PROGRAM_CODES,
} = require('../app/services/verticals/eaa595e1');

const fs = require('fs');

const {
  buildFeatureView, encodeSegment, readSpec, serialize, ARTIFACT_PATH,
} = require('../pipelines/kroger/build-offer-features');
const { auditTier, storefrontTiers } = require('../scripts/kroger-personalization-audit');

const spec = readSpec();

describe('offer-affinity feature build', () => {
  test('encodes every segment as a dense vector over the category vocabulary', () => {
    const view = buildFeatureView(spec);

    Object.values(view.segments).forEach((vector) => {
      expect(Object.keys(vector)).toEqual(spec.categoryVocabulary);
    });
  });

  test('fails the build when a segment declares no weights rather than shipping a zero vector', () => {
    expect(() => encodeSegment({ cohortSize: 100 }, ['dairy'], 'boost_annual'))
      .toThrow(/boost_annual.*no weights/);
  });

  test('fails legibly on a malformed spec rather than throwing a raw TypeError', () => {
    expect(() => buildFeatureView({ segments: {} })).toThrow(/categoryVocabulary/);
    expect(() => buildFeatureView({ categoryVocabulary: ['dairy'] })).toThrow(/segments/);
    expect(() => buildFeatureView({ categoryVocabulary: ['dairy'], segments: { boost_annual: null } }))
      .toThrow(/boost_annual.*not an object/);
  });

  test('rejects weights outside the normalized [0,1] range instead of materializing them', () => {
    [-0.4, 1.4, NaN, Infinity].forEach((weight) => {
      expect(() => encodeSegment({ weights: { dairy: weight } }, ['dairy'], 'boost_monthly'))
        .toThrow(/boost_monthly.*dairy.*\[0,1\]/);
    });
  });

  test('rejects weights keyed to categories outside the vocabulary instead of dropping them', () => {
    expect(() => encodeSegment({ weights: { dairy: 0.5, groceries: 0.6 } }, ['dairy', 'grocery'], 'boost_monthly'))
      .toThrow(/boost_monthly.*"groceries".*vocabulary/);
  });

  test('names the offending non-finite value instead of rendering it as null', () => {
    expect(() => encodeSegment({ weights: { dairy: NaN } }, ['dairy'], 'boost_monthly'))
      .toThrow(/weight NaN for category "dairy"/);
    expect(() => encodeSegment({ weights: { dairy: Infinity } }, ['dairy'], 'boost_monthly'))
      .toThrow(/weight Infinity for category "dairy"/);
  });

  test('rounds encoded weights to the 2dp the spec documents', () => {
    expect(encodeSegment({ weights: { dairy: 0.4449 } }, ['dairy'])).toEqual({ dairy: 0.44 });
  });

  test('encodes a category the segment has no basket history for as 0, not undefined', () => {
    const vector = encodeSegment({ weights: { dairy: 0.5 } }, ['dairy', 'produce']);

    expect(vector).toEqual({ dairy: 0.5, produce: 0 });
  });

  test('committed artifact matches a fresh build of the spec', () => {
    expect(buildFeatureView(spec)).toEqual(OFFER_AFFINITY_VIEW);
  });

  test('committed artifact is byte-identical to a fresh build, so a hand-edit fails the suite', () => {
    expect(fs.readFileSync(ARTIFACT_PATH, 'utf8')).toBe(serialize(buildFeatureView(spec)));
  });
});

describe('offer ranking', () => {
  test('personalizes a tier the feature view encodes, ranked by descending affinity', () => {
    const result = rankOffers('boost-monthly', OFFER_POOL.length);
    const scores = result.offers.map((offer) => offer.score);

    expect(result.segment).toBe('boost_monthly');
    expect(result.segmentEncoded).toBe(true);
    expect(result.personalized).toBe(true);
    expect(result.matchRate).toBe(1);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test('serves the unranked pool without throwing when the feature view has no vector for the segment', () => {
    const result = rankOffers('boost-annual', OFFER_POOL.length);

    expect(result.segment).toBe('boost_annual');
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
    const original = Object.getOwnPropertyDescriptor(OFFER_AFFINITY_VIEW.segments, 'boost_annual');
    try {
      OFFER_AFFINITY_VIEW.segments.boost_annual = { dairy: 0.7, meat: 0.9 };
      const result = rankOffers('boost-annual', 4);

      expect(result.personalized).toBe(true);
      expect(result.offers).toHaveLength(4);
      // Scored offers rank first, in descending order; the rest backfill behind them.
      expect(result.offers.map((offer) => offer.score)).toEqual([0.9, 0.7, 0, 0]);
      // Partial coverage is the only case that yields a match rate strictly between
      // 0 and 1, which the rounded response reports as 0.33 of the 6-offer pool.
      expect(result.matchRate).toBe(0.33);
    } finally {
      if (original) {
        Object.defineProperty(OFFER_AFFINITY_VIEW.segments, 'boost_annual', original);
      } else {
        delete OFFER_AFFINITY_VIEW.segments.boost_annual;
      }
    }
  });

  test('treats a segment entry that carries no category keys as unencoded', () => {
    // Only reachable by hand-editing the artifact past the build; the point is that
    // scoring it degrades silently rather than throwing, and reports the honest reason.
    // The view is require-cached and shared, and boost_annual stops being absent the
    // moment the planted gap is fixed — so restore whatever was there, don't delete.
    const original = Object.getOwnPropertyDescriptor(OFFER_AFFINITY_VIEW.segments, 'boost_annual');
    try {
      [[], 'boost_annual', 7].forEach((entry) => {
        OFFER_AFFINITY_VIEW.segments.boost_annual = entry;
        expect(resolveOfferSegment('boost-annual').encoded).toBe(false);
        expect(rankOffers('boost-annual').personalized).toBe(false);
      });
    } finally {
      if (original) {
        Object.defineProperty(OFFER_AFFINITY_VIEW.segments, 'boost_annual', original);
      } else {
        delete OFFER_AFFINITY_VIEW.segments.boost_annual;
      }
    }
  });

  test('resolves inherited Object.prototype keys to the standard segment', () => {
    ['constructor', 'toString', 'hasOwnProperty'].forEach((membership) => {
      expect(resolveOfferSegment(membership).code).toBe('standard');
    });
  });
});

describe('personalization coverage audit', () => {
  test('audits the tiers the storefront can send, not the ones the spec happens to declare', () => {
    expect(storefrontTiers()).toEqual(Object.keys(MEMBERSHIP_FUEL_PROGRAM_CODES));
  });

  test('flags a tier the service serves but the spec never declared', () => {
    const row = auditTier('boost-quarterly');

    expect(row.declared).toBe(false);
    expect(row.segment).toBe('standard');
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

    expect(uncovered.map((row) => row.membership)).toEqual(['boost-annual']);
    expect(uncovered[0].matchRate).toBe(0);
    expect(uncovered[0].personalized).toBe(false);
  });

  test('the uncovered tier is the same one that crashes checkout', () => {
    expect(() => computeFuelPoints(42.5, 'boost-annual')).toThrow(/pointsPerDollar/);
    expect(computeFuelPoints(42.5, 'boost-monthly').points).toBe(84);
  });
});
