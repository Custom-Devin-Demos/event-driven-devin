const {
  processAccountActivation,
  REGION_PARTITIONS,
  selectTierTerms,
} = require('../app/services/verticals/40cf3e09');

describe('Account activation service (40cf3e09)', () => {
  test('activates a free-tier account in us-east-1 (the reported failure case)', async () => {
    const result = await processAccountActivation({
      planTier: 'free',
      region: 'us-east-1',
    });

    expect(result.success).toBe(true);
    expect(result.activation.accountRegion).toBe('us-east-1');
    expect(result.activation.zone).toBe(REGION_PARTITIONS['us-east-1'].zone);
    expect(result.activation.totalCredits).toBe(200);
    expect(result.activation.expiresInMonths).toBe(6);
  });

  test('uses the geo-specific credit schedule for a non-NA region', async () => {
    const result = await processAccountActivation({
      planTier: 'starter',
      region: 'ap-southeast-1',
    });

    expect(result.activation.zone).toBe('SIN');
    expect(result.activation.totalCredits).toBe(420);
    expect(result.activation.expiresInMonths).toBe(12);
  });

  test('falls back to the free tier for an unknown plan tier', async () => {
    const result = await processAccountActivation({
      planTier: 'does-not-exist',
      region: 'eu-west-1',
    });

    expect(result.success).toBe(true);
    expect(result.activation.totalCredits).toBe(180);
  });

  test('falls back to us-east-1 for an unknown region', async () => {
    const result = await processAccountActivation({
      planTier: 'free',
      region: 'mars-central-1',
    });

    expect(result.activation.zone).toBe('IAD');
    expect(result.activation.totalCredits).toBe(200);
  });

  test('selectTierTerms returns terms for missing and undefined tiers instead of undefined', () => {
    const schedule = [
      { tier: 'free', terms: { baseCredits: 1, bonusCredits: 2, windowMonths: 3 } },
      { tier: 'starter', terms: { baseCredits: 4, bonusCredits: 5, windowMonths: 6 } },
    ];

    expect(selectTierTerms(schedule, 'starter').baseCredits).toBe(4);
    expect(selectTierTerms(schedule, 'enterprise').baseCredits).toBe(1);
    expect(selectTierTerms(schedule, undefined).baseCredits).toBe(1);
  });
});
