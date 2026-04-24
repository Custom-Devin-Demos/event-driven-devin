jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { processRewardsLookup, MEMBERS } = require('./b62fa21d');

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
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

describe('processRewardsLookup', () => {
  it('succeeds for a platinum-tier member', async () => {
    const result = await processRewardsLookup({
      email: 'alice.chen@example.com',
      memberId: 'RL-10042891',
      tier: 'platinum',
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('platinum');
    expect(result.member).toBe('Alice Chen');
    expect(parseFloat(result.rewardsBalance)).toBeGreaterThan(0);
  });

  it('succeeds for a gold-tier member', async () => {
    const result = await processRewardsLookup({
      email: 'james.wright@example.com',
      memberId: 'RL-10098234',
      tier: 'gold',
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('gold');
  });

  it('succeeds for a silver-tier member', async () => {
    const result = await processRewardsLookup({
      email: 'sofia.martinez@example.com',
      memberId: 'RL-10071562',
      tier: 'silver',
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('silver');
  });

  it('uses the member default tier when no tier is provided', async () => {
    const result = await processRewardsLookup({
      email: 'alice.chen@example.com',
      memberId: 'RL-10042891',
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('platinum');
  });

  it('throws for a non-existent member', async () => {
    await expect(
      processRewardsLookup({
        email: 'nobody@example.com',
        memberId: 'RL-00000000',
        tier: 'gold',
      })
    ).rejects.toThrow('Member not found');
  });

  it('calculates correct rewards balance for platinum tier', async () => {
    const result = await processRewardsLookup({
      email: 'alice.chen@example.com',
      memberId: 'RL-10042891',
      tier: 'platinum',
    });

    // platinum: multiplier=3.0, annualBonus=500
    // Alice: 12450 points * 0.01 = 124.50 pointsValue
    // baseRewards = 124.50 * 3.0 = 373.50
    // totalRewards = 373.50 + 500 = 873.50
    expect(result.rewardsBalance).toBe('873.50');
  });

  it('includes nextTier information', async () => {
    const result = await processRewardsLookup({
      email: 'sofia.martinez@example.com',
      memberId: 'RL-10071562',
      tier: 'silver',
    });

    expect(result.nextTier).toBeDefined();
    expect(result.nextTier.nextTier).toBe('gold');
  });
});
