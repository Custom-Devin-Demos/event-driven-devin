jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

const {
  rankOffers,
  resolveOfferSegment,
  computeFuelPoints,
  OFFER_POOL,
  OFFER_AFFINITY_VIEW,
} = require('../app/services/verticals/eaa595e1');

const { buildFeatureView, encodeSegment, readSpec } = require('../pipelines/kroger/build-offer-features');
const { auditTier } = require('../scripts/kroger-personalization-audit');

const spec = readSpec();

describe('offer-affinity feature build', () => {
  test('encodes every segment as a dense vector over the category vocabulary', () => {
    const view = buildFeatureView(spec);

    Object.values(view.segments).forEach((vector) => {
      expect(Object.keys(vector)).toEqual(spec.categoryVocabulary);
    });
  });

  test('encodes a category the segment has no basket history for as 0, not undefined', () => {
    const vector = encodeSegment({ weights: { dairy: 0.5 } }, ['dairy', 'produce']);

    expect(vector).toEqual({ dairy: 0.5, produce: 0 });
  });

  test('committed artifact matches a fresh build of the spec', () => {
    expect(buildFeatureView(spec)).toEqual(OFFER_AFFINITY_VIEW);
  });
});

describe('offer ranking', () => {
  test('personalizes a tier the feature view encodes, ranked by descending affinity', () => {
    const result = rankOffers('boost-monthly', OFFER_POOL.length);
    const scores = result.offers.map((offer) => offer.score);

    expect(result.segment).toBe('boost_monthly');
    expect(result.personalized).toBe(true);
    expect(result.matchRate).toBe(1);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
  });

  test('serves the unranked pool without throwing when the feature view has no vector for the segment', () => {
    const result = rankOffers('boost-annual', OFFER_POOL.length);

    expect(result.segment).toBe('boost_annual');
    expect(result.personalized).toBe(false);
    expect(result.matchRate).toBe(0);
    expect(result.offers).toHaveLength(OFFER_POOL.length);
    expect(result.offers.every((offer) => offer.score === 0)).toBe(true);
  });

  test('resolves inherited Object.prototype keys to the standard segment', () => {
    ['constructor', 'toString', 'hasOwnProperty'].forEach((membership) => {
      expect(resolveOfferSegment(membership).code).toBe('standard');
    });
  });
});

describe('personalization coverage audit', () => {
  test('flags every membership tier the feature view cannot personalize', () => {
    const uncovered = Object.keys(spec.membershipTiers)
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
