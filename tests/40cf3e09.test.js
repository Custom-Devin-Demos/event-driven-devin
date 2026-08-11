const {
  processAccountActivation,
  REGION_PARTITIONS,
  CREDIT_SCHEDULES,
  loadCreditSchedule,
  selectTierTerms,
  buildActivationPackage,
} = require('../app/services/verticals/40cf3e09');

describe('account activation service (40cf3e09)', () => {
  test('activates a free plan in us-east-1 (the request that threw the TypeError)', async () => {
    const result = await processAccountActivation({ planTier: 'free', region: 'us-east-1' });

    expect(result.success).toBe(true);
    expect(result.activation).toEqual({
      accountRegion: 'us-east-1',
      zone: 'IAD',
      totalCredits: 200,
      expiresInMonths: 6,
    });
  });

  test('applies the geo-specific credit schedule rather than the NA default', async () => {
    const result = await processAccountActivation({ planTier: 'starter', region: 'ap-southeast-1' });

    expect(result.activation.zone).toBe('SIN');
    expect(result.activation.totalCredits).toBe(260 + 160);
  });

  test('every geo/tier combination resolves terms instead of undefined', () => {
    for (const [geo, entries] of Object.entries(CREDIT_SCHEDULES)) {
      const schedule = loadCreditSchedule(geo);
      for (const [tier] of entries) {
        expect(selectTierTerms(schedule, tier)).toBeDefined();
      }
    }
  });

  test('unknown plan tier raises a validation error, not a TypeError', () => {
    const regionInfo = { region: 'us-east-1', ...REGION_PARTITIONS['us-east-1'] };

    expect(() => buildActivationPackage(regionInfo, 'enterprise')).toThrow(/Unknown plan tier/);
    try {
      buildActivationPackage(regionInfo, 'enterprise');
    } catch (error) {
      expect(error.name).not.toBe('TypeError');
      expect(error.code).toBe('UNKNOWN_PLAN_TIER');
    }
  });

  test('unrecognized region falls back to the NA schedule', () => {
    const regionInfo = { region: 'sa-east-1', ...REGION_PARTITIONS['us-east-1'] };

    expect(buildActivationPackage(regionInfo, 'free').totalCredits).toBe(200);
  });
});
