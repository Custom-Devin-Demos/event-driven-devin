// uuid v13 ships ESM only; stub it so Jest's CommonJS runtime can load the module.
jest.mock('uuid', () => ({ v4: () => '00000000-0000-0000-0000-000000000000' }));

// Prevent the error path from posting real Slack alerts / Devin sessions during tests.
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const {
  processRewardsLookup,
  findMember,
  resolveTierBenefits,
  calculateRewardsBalance,
  TIER_CONFIG,
  MEMBERS,
} = require('./b62fa21d');

const platinumMember = MEMBERS.find((m) => m.tier === 'platinum');

describe('resolveTierBenefits', () => {
  it('includes the resolved tier config so downstream calculation can read it', () => {
    const memberData = findMember({ email: platinumMember.email });
    const tierBenefits = resolveTierBenefits(memberData, undefined);

    // Regression: tierBenefits.config was previously undefined, causing
    // "Cannot read properties of undefined (reading 'multiplier')".
    expect(tierBenefits.config).toBeDefined();
    expect(tierBenefits.config.multiplier).toBe(TIER_CONFIG.platinum.multiplier);
    expect(tierBenefits.config.annualBonus).toBe(TIER_CONFIG.platinum.annualBonus);
    expect(tierBenefits.tier).toBe('platinum');
  });

  it('honors an explicitly requested tier over the member default', () => {
    const memberData = findMember({ email: platinumMember.email });
    const tierBenefits = resolveTierBenefits(memberData, 'silver');

    expect(tierBenefits.tier).toBe('silver');
    expect(tierBenefits.config.multiplier).toBe(TIER_CONFIG.silver.multiplier);
  });

  it('returns null for an unknown tier (edge case)', () => {
    const memberData = findMember({ email: platinumMember.email });
    expect(resolveTierBenefits(memberData, 'titanium')).toBeNull();
  });
});

describe('calculateRewardsBalance', () => {
  it('does not throw and computes the balance from the tier multiplier (regression)', () => {
    const memberData = findMember({ email: platinumMember.email });
    const tierBenefits = resolveTierBenefits(memberData, undefined);

    expect(() => calculateRewardsBalance(memberData, tierBenefits)).not.toThrow();

    const balance = calculateRewardsBalance(memberData, tierBenefits);
    const expectedPointsValue = memberData.rewards.currentPoints * 0.01;
    const expectedTotal =
      expectedPointsValue * TIER_CONFIG.platinum.multiplier + TIER_CONFIG.platinum.annualBonus;

    expect(balance.tierMultiplier).toBe(TIER_CONFIG.platinum.multiplier);
    expect(balance.rewardsBalance).toBe(expectedTotal.toFixed(2));
  });
});

describe('processRewardsLookup', () => {
  it('completes a platinum rewards lookup without error (reproduces the original failing request)', async () => {
    const result = await processRewardsLookup({ email: platinumMember.email });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('platinum');
    expect(result.member).toBe(platinumMember.name);
    expect(typeof result.rewardsBalance).toBe('string');
  });

  it.each(['platinum', 'gold', 'silver'])(
    'completes a lookup for a member whose tier is %s',
    async (tier) => {
      const member = MEMBERS.find((m) => m.tier === tier);
      const result = await processRewardsLookup({ memberId: member.id });

      expect(result.success).toBe(true);
      expect(result.tier).toBe(tier);
    }
  );

  it('rejects when the member cannot be found', async () => {
    await expect(
      processRewardsLookup({ email: 'nobody@example.com' })
    ).rejects.toThrow(/Member not found/);
  });
});
