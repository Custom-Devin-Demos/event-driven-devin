jest.mock('uuid', () => ({ v4: () => 'test-lookup-id' }));
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));
jest.mock('../../telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../../telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve()),
}));

const {
  processRewardsLookup,
  resolveTierBenefits,
  calculateRewardsBalance,
  findMember,
} = require('./b62fa21d');

const PLATINUM_EMAIL = 'alice.chen@example.com';

describe('resolveTierBenefits', () => {
  // Regression: previously returned { tier, benefits: [...] } with no `config`,
  // which caused calculateRewardsBalance to read `.config.multiplier` off undefined.
  it('returns a config object that exposes multiplier/annualBonus/minSpend', () => {
    const memberData = findMember({ email: PLATINUM_EMAIL });
    const result = resolveTierBenefits(memberData, 'platinum');

    expect(result).toEqual({
      tier: 'platinum',
      config: { multiplier: 3.0, annualBonus: 500, minSpend: 5000 },
    });
    expect(result.config.multiplier).toBe(3.0);
  });

  it('falls back to the member tier when no tier is requested', () => {
    const memberData = findMember({ email: PLATINUM_EMAIL });
    const result = resolveTierBenefits(memberData, undefined);
    expect(result.tier).toBe('platinum');
    expect(result.config.multiplier).toBe(3.0);
  });

  it('returns null for an unknown tier (edge case that triggered the error)', () => {
    const memberData = findMember({ email: PLATINUM_EMAIL });
    expect(resolveTierBenefits(memberData, 'diamond')).toBeNull();
  });
});

describe('calculateRewardsBalance', () => {
  // Reproduces the original failure condition: feeding resolveTierBenefits output
  // into calculateRewardsBalance previously threw
  // "TypeError: Cannot read properties of undefined (reading 'multiplier')".
  it('computes the balance without throwing on resolveTierBenefits output', () => {
    const memberData = findMember({ email: PLATINUM_EMAIL });
    const tierBenefits = resolveTierBenefits(memberData, 'platinum');

    expect(() => calculateRewardsBalance(memberData, tierBenefits)).not.toThrow();

    const balance = calculateRewardsBalance(memberData, tierBenefits);
    expect(balance.tierMultiplier).toBe(3.0);
    // 12450 points * 0.01 * 3.0 + 500 annual bonus = 873.50
    expect(balance.rewardsBalance).toBe('873.50');
  });
});

describe('processRewardsLookup', () => {
  it('succeeds for a platinum member (regression for the reported alert)', async () => {
    const result = await processRewardsLookup({
      email: PLATINUM_EMAIL,
      tier: 'platinum',
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('platinum');
    expect(result.rewardsBalance).toBe('873.50');
    expect(result.member).toBe('Alice Chen');
  });

  it('throws a clean InvalidTierError (not a TypeError) for an unknown tier', async () => {
    await expect(
      processRewardsLookup({ email: PLATINUM_EMAIL, tier: 'diamond' })
    ).rejects.toMatchObject({ name: 'InvalidTierError', code: 'INVALID_TIER' });
  });

  it('throws MemberNotFoundError when the member does not exist', async () => {
    await expect(
      processRewardsLookup({ email: 'nobody@example.com', tier: 'gold' })
    ).rejects.toMatchObject({ name: 'MemberNotFoundError' });
  });
});
