jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { processRewardsLookup } = require('./b62fa21d');

jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../../telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

jest.mock('../../telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

describe('processRewardsLookup', () => {
  it('should successfully look up rewards for a platinum member', async () => {
    const result = await processRewardsLookup({
      email: 'alice.chen@example.com',
      memberId: 'RL-10042891',
      tier: 'platinum',
    });

    expect(result.success).toBe(true);
    expect(result.member).toBe('Alice Chen');
    expect(result.tier).toBe('platinum');
    expect(result.points).toBe(12450);
    expect(parseFloat(result.rewardsBalance)).toBeGreaterThan(0);
  });

  it('should successfully look up rewards for a gold member', async () => {
    const result = await processRewardsLookup({
      email: 'james.wright@example.com',
      memberId: 'RL-10098234',
      tier: 'gold',
    });

    expect(result.success).toBe(true);
    expect(result.member).toBe('James Wright');
    expect(result.tier).toBe('gold');
  });

  it('should successfully look up rewards for a silver member', async () => {
    const result = await processRewardsLookup({
      email: 'sofia.martinez@example.com',
      memberId: 'RL-10071562',
      tier: 'silver',
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('silver');
  });

  it('should use the member default tier when no tier is specified', async () => {
    const result = await processRewardsLookup({
      email: 'alice.chen@example.com',
      memberId: 'RL-10042891',
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('platinum');
  });

  it('should calculate correct rewards balance with tier multiplier', async () => {
    const result = await processRewardsLookup({
      email: 'alice.chen@example.com',
      memberId: 'RL-10042891',
      tier: 'platinum',
    });

    // points=12450, pointsValue=124.50, multiplier=3.0, base=373.50, bonus=500
    expect(result.rewardsBalance).toBe('873.50');
  });

  it('should throw for a non-existent member', async () => {
    await expect(
      processRewardsLookup({
        email: 'nobody@example.com',
        memberId: 'RL-99999999',
        tier: 'gold',
      })
    ).rejects.toThrow('Member not found');
  });

  it('should include nextTier information in the response', async () => {
    const result = await processRewardsLookup({
      email: 'sofia.martinez@example.com',
      memberId: 'RL-10071562',
      tier: 'silver',
    });

    expect(result.nextTier).toBeDefined();
    expect(result.nextTier.nextTier).toBe('gold');
    expect(result.nextTier.amountNeeded).toBeGreaterThanOrEqual(0);
  });

  it('should include recent purchases in the response', async () => {
    const result = await processRewardsLookup({
      email: 'alice.chen@example.com',
      memberId: 'RL-10042891',
      tier: 'platinum',
    });

    expect(result.recentPurchases).toBeDefined();
    expect(result.recentPurchases.length).toBeGreaterThan(0);
  });
});
