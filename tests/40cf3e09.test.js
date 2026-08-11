const {
  processAccountActivation,
  buildActivationPackage,
  resolveRegion,
  loadCreditSchedule,
  selectTierTerms,
  CREDIT_SCHEDULES,
  REGION_PARTITIONS,
} = require('../app/services/verticals/40cf3e09');

describe('Account activation service (40cf3e09)', () => {
  test('activates a free-tier account in us-east-1 (original failure condition)', async () => {
    const result = await processAccountActivation({ planTier: 'free', region: 'us-east-1' });

    expect(result.success).toBe(true);
    expect(result.activation).toEqual({
      accountRegion: 'us-east-1',
      zone: 'IAD',
      totalCredits: 200,
      expiresInMonths: 6,
    });
  });

  test('builds a package for every tier in every geo schedule', () => {
    for (const [geo, entries] of Object.entries(CREDIT_SCHEDULES)) {
      const regionInfo = { region: 'test-region', geo, zone: 'TST' };
      for (const [tier, terms] of entries) {
        const activation = buildActivationPackage(regionInfo, tier);
        expect(activation.totalCredits).toBe(terms.baseCredits + terms.bonusCredits);
        expect(activation.expiresInMonths).toBe(terms.windowMonths);
      }
    }
  });

  test('falls back to the free tier for an unknown plan tier instead of throwing', () => {
    const regionInfo = resolveRegion('eu-west-1');
    const activation = buildActivationPackage(regionInfo, 'enterprise-platinum');

    expect(activation.zone).toBe('DUB');
    expect(activation.totalCredits).toBe(180);
  });

  test('falls back to the NA schedule and us-east-1 partition for an unknown region', async () => {
    const result = await processAccountActivation({ planTier: 'starter', region: 'mars-north-1' });

    expect(result.success).toBe(true);
    expect(result.activation.zone).toBe('IAD');
    expect(result.activation.totalCredits).toBe(500);
  });

  test('a missing plan tier resolves to the default rather than dereferencing undefined', () => {
    expect(selectTierTerms(loadCreditSchedule('NA'), 'nope')).toBeUndefined();
    expect(buildActivationPackage({ region: 'r', geo: 'NA', zone: 'Z' }, undefined).totalCredits)
      .toBe(200);
  });

  test('every geo in the credit schedules is reachable from a region partition', () => {
    const geos = new Set(Object.values(REGION_PARTITIONS).map((meta) => meta.geo));
    for (const geo of Object.keys(CREDIT_SCHEDULES)) {
      expect(geos.has(geo)).toBe(true);
      expect(loadCreditSchedule(geo).length).toBeGreaterThan(0);
    }
  });
});
