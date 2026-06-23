jest.mock('uuid', () => ({
  v4: () => 'test-uuid-0000-0000-000000000000',
}));

const { processRewardsLookup } = require('./b62fa21d');

jest.mock('../../telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../../telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

describe('processRewardsLookup', () => {
  // Regression: before the fix, resolveTierBenefits returned no `config`
  // property, so calculateRewardsBalance threw
  // "TypeError: Cannot read properties of undefined (reading 'multiplier')".
  it('returns a rewards balance for a valid member without throwing', async () => {
    const result = await processRewardsLookup({ email: 'alice.chen@example.com' });

    expect(result.success).toBe(true);
    expect(result.member).toBe('Alice Chen');
    expect(result.tier).toBe('platinum');
    // points 12450 * 0.01 = 124.50; * 3.0 multiplier = 373.50; + 500 bonus = 873.50
    expect(result.rewardsBalance).toBe('873.50');
  });

  it('applies the correct tier multiplier for each tier', async () => {
    const gold = await processRewardsLookup({ email: 'james.wright@example.com' });
    // 6820 * 0.01 = 68.20; * 2.0 = 136.40; + 250 = 386.40
    expect(gold.tier).toBe('gold');
    expect(gold.rewardsBalance).toBe('386.40');

    const silver = await processRewardsLookup({ email: 'sofia.martinez@example.com' });
    // 2340 * 0.01 = 23.40; * 1.0 = 23.40; + 100 = 123.40
    expect(silver.tier).toBe('silver');
    expect(silver.rewardsBalance).toBe('123.40');
  });

  it('honors an explicitly requested tier override', async () => {
    // Platinum member requesting gold benefits
    const result = await processRewardsLookup({
      email: 'alice.chen@example.com',
      tier: 'gold',
    });
    expect(result.success).toBe(true);
    expect(result.tier).toBe('gold');
    // 12450 * 0.01 = 124.50; * 2.0 = 249.00; + 250 = 499.00
    expect(result.rewardsBalance).toBe('499.00');
  });

  it('rejects with MemberNotFoundError when the member does not exist', async () => {
    await expect(
      processRewardsLookup({ email: 'nobody@example.com' })
    ).rejects.toMatchObject({
      name: 'MemberNotFoundError',
      code: 'MEMBER_NOT_FOUND',
    });
  });
});
