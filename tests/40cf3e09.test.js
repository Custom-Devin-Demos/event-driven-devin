const {
  processAccountActivation,
  REGION_PARTITIONS,
  selectTierTerms,
} = require('../app/services/verticals/40cf3e09');

describe('Account activation service (40cf3e09)', () => {
  test('activates a free plan in us-east-1 (the reported failure case)', async () => {
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

  test('applies geo-specific credit terms for a starter plan in eu-west-1', async () => {
    const result = await processAccountActivation({
      planTier: 'starter',
      region: 'eu-west-1',
    });

    expect(result.activation.zone).toBe('DUB');
    expect(result.activation.totalCredits).toBe(460);
    expect(result.activation.expiresInMonths).toBe(12);
  });

  test('falls back to the us-east-1 partition for an unknown region', async () => {
    const result = await processAccountActivation({
      planTier: 'free',
      region: 'mars-central-1',
    });

    expect(result.activation.zone).toBe('IAD');
    expect(result.activation.totalCredits).toBe(200);
  });

  test('rejects a plan tier that has no credit schedule instead of throwing a TypeError', async () => {
    await expect(
      processAccountActivation({ planTier: 'enterprise', region: 'us-east-1' })
    ).rejects.toThrow('No credit schedule for plan tier "enterprise"');

    await expect(
      processAccountActivation({ planTier: 'enterprise', region: 'us-east-1' })
    ).rejects.not.toThrow(TypeError);
  });

  test('selectTierTerms looks tiers up by name, not by array index', () => {
    const schedule = [
      { tier: 'free', terms: { baseCredits: 1 } },
      { tier: 'starter', terms: { baseCredits: 2 } },
    ];

    expect(selectTierTerms(schedule, 'starter')).toEqual({ baseCredits: 2 });
    expect(selectTierTerms(schedule, 'missing')).toBeUndefined();
  });
});
