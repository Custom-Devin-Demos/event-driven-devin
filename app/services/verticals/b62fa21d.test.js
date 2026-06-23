jest.mock('uuid', () => ({ v4: () => 'test-lookup-id' }));

const { processRewardsLookup, MEMBERS } = require('./b62fa21d');

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
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const platinumMember = MEMBERS.find((m) => m.tier === 'platinum');
const goldMember = MEMBERS.find((m) => m.tier === 'gold');
const silverMember = MEMBERS.find((m) => m.tier === 'silver');

describe('processRewardsLookup', () => {
  // Reproduces the original production failure: looking up a platinum member
  // used to throw "Cannot read properties of undefined (reading 'multiplier')"
  // because resolveTierBenefits returned no `config` key that
  // calculateRewardsBalance expected.
  it('returns a rewards balance for a platinum member (the original crash case)', async () => {
    const result = await processRewardsLookup({
      email: platinumMember.email,
      memberId: platinumMember.id,
      tier: 'platinum',
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('platinum');
    // points 12450 -> pointsValue 124.50 * multiplier 3.0 = 373.50 + annualBonus 500 = 873.50
    expect(result.rewardsBalance).toBe('873.50');
    expect(result.points).toBe(platinumMember.points);
  });

  it('computes the balance using the correct multiplier for each tier', async () => {
    const gold = await processRewardsLookup({
      email: goldMember.email,
      memberId: goldMember.id,
      tier: 'gold',
    });
    // 6820 * 0.01 = 68.20 * 2.0 = 136.40 + 250 = 386.40
    expect(gold.rewardsBalance).toBe('386.40');

    const silver = await processRewardsLookup({
      email: silverMember.email,
      memberId: silverMember.id,
      tier: 'silver',
    });
    // 2340 * 0.01 = 23.40 * 1.0 = 23.40 + 100 = 123.40
    expect(silver.rewardsBalance).toBe('123.40');
  });

  it('falls back to the member profile tier when no tier is supplied', async () => {
    const result = await processRewardsLookup({
      email: platinumMember.email,
      memberId: platinumMember.id,
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('platinum');
    expect(result.rewardsBalance).toBe('873.50');
  });

  // Edge case that previously surfaced as the undefined-property TypeError:
  // an unrecognized tier must produce a clean, typed error instead.
  it('throws a typed InvalidTierError for an unknown tier (not a TypeError)', async () => {
    await expect(
      processRewardsLookup({
        email: platinumMember.email,
        memberId: platinumMember.id,
        tier: 'diamond',
      })
    ).rejects.toMatchObject({ name: 'InvalidTierError', code: 'INVALID_TIER' });
  });

  it('throws MemberNotFoundError when the member does not exist', async () => {
    await expect(
      processRewardsLookup({
        email: 'nobody@example.com',
        memberId: 'RL-00000000',
        tier: 'gold',
      })
    ).rejects.toMatchObject({ name: 'MemberNotFoundError', code: 'MEMBER_NOT_FOUND' });
  });
});
