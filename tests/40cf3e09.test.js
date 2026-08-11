const {
  processAccountActivation,
  buildActivationPackage,
  loadCreditSchedule,
  selectTierTerms,
  CREDIT_SCHEDULES,
  REGION_PARTITIONS,
} = require('../app/services/verticals/40cf3e09');

describe('Account activation service (40cf3e09)', () => {
  test('activates a free-tier account in us-east-1 (the failing production request)', async () => {
    const result = await processAccountActivation({
      planTier: 'free',
      region: 'us-east-1',
    });

    expect(result.success).toBe(true);
    expect(result.activation).toEqual({
      accountRegion: 'us-east-1',
      zone: 'IAD',
      totalCredits: 200,
      expiresInMonths: 6,
    });
  });

  test('resolves tier terms for every tier in every geo schedule', () => {
    for (const [geo, entries] of Object.entries(CREDIT_SCHEDULES)) {
      const schedule = loadCreditSchedule(geo);
      for (const [tier, terms] of entries) {
        expect(selectTierTerms(schedule, tier)).toEqual(terms);
      }
    }
  });

  test('builds a package for each known region using that region geo schedule', () => {
    for (const [region, meta] of Object.entries(REGION_PARTITIONS)) {
      const pkg = buildActivationPackage({ region, ...meta }, 'starter');
      const expected = selectTierTerms(loadCreditSchedule(meta.geo), 'starter');

      expect(pkg.accountRegion).toBe(region);
      expect(pkg.zone).toBe(meta.zone);
      expect(pkg.totalCredits).toBe(expected.baseCredits + expected.bonusCredits);
      expect(pkg.expiresInMonths).toBe(expected.windowMonths);
    }
  });

  test('falls back to the NA schedule for an unmapped region', async () => {
    const result = await processAccountActivation({
      planTier: 'starter',
      region: 'sa-east-1',
    });

    expect(result.success).toBe(true);
    expect(result.activation.totalCredits).toBe(500);
    expect(result.activation.zone).toBe('IAD');
  });

  test('throws a typed error instead of dereferencing undefined for an unknown tier', () => {
    expect(() => buildActivationPackage({ region: 'us-east-1', geo: 'NA', zone: 'IAD' }, 'enterprise'))
      .toThrow(expect.objectContaining({ name: 'UnknownPlanTierError', code: 'UNKNOWN_PLAN_TIER' }));
  });

  test('does not throw a TypeError when the plan tier is missing', () => {
    for (const planTier of [undefined, null, '']) {
      let thrown;
      try {
        buildActivationPackage({ region: 'eu-west-1', geo: 'EU', zone: 'DUB' }, planTier);
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeDefined();
      expect(thrown).not.toBeInstanceOf(TypeError);
      expect(thrown.code).toBe('UNKNOWN_PLAN_TIER');
    }
  });
});
