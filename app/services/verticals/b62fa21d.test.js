// uuid v13 ships ESM that Jest's default (no-babel) transform can't parse.
jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

const {
  processRewardsLookup,
  resolveTierBenefits,
  calculateRewardsBalance,
  findMember,
} = require('./b62fa21d');

describe('rewards lookup — tier benefits regression', () => {
  // Regression for: TypeError: Cannot read properties of undefined (reading 'multiplier')
  // resolveTierBenefits() used to return { tier, benefits: [...] } while
  // calculateRewardsBalance() reads tierBenefits.config.multiplier, so config was undefined.

  test('processRewardsLookup succeeds for a platinum member (original failure now resolves)', async () => {
    const result = await processRewardsLookup({
      memberId: 'RL-10042891',
      tier: 'platinum',
    });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('platinum');
    // 12450 points * 0.01 = 124.50; * 3.0 multiplier = 373.50; + 500 bonus = 873.50
    expect(result.rewardsBalance).toBe('873.50');
  });

  test('processRewardsLookup uses the member default tier when none is requested', async () => {
    const result = await processRewardsLookup({ email: 'james.wright@example.com' });

    expect(result.success).toBe(true);
    expect(result.tier).toBe('gold');
  });

  test('resolveTierBenefits exposes a config object with the tier multiplier', () => {
    const memberData = findMember({ memberId: 'RL-10042891' });
    const tierBenefits = resolveTierBenefits(memberData, 'platinum');

    expect(tierBenefits).toMatchObject({
      tier: 'platinum',
      config: { multiplier: 3.0, annualBonus: 500, minSpend: 5000 },
    });
  });

  test('calculateRewardsBalance reads config.multiplier without throwing', () => {
    const memberData = findMember({ memberId: 'RL-10042891' });
    const tierBenefits = resolveTierBenefits(memberData, 'platinum');

    expect(() => calculateRewardsBalance(memberData, tierBenefits)).not.toThrow();
    const balance = calculateRewardsBalance(memberData, tierBenefits);
    expect(balance.tierMultiplier).toBe(3.0);
    expect(balance.rewardsBalance).toBe('873.50');
  });

  test('resolveTierBenefits returns null for an unknown tier (edge case)', () => {
    const memberData = findMember({ memberId: 'RL-10042891' });
    expect(resolveTierBenefits(memberData, 'unobtanium')).toBeNull();
  });
});
