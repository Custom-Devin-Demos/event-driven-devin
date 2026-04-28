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
  Sentry: { captureException: jest.fn(), withScope: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn(),
}));

const {
  findMember,
  resolveTierBenefits,
  calculateRewardsBalance,
} = require('./b62fa21d');

describe('b62fa21d rewards service', () => {
  describe('resolveTierBenefits', () => {
    it('should return a config object with multiplier, annualBonus, and minSpend', () => {
      const memberData = { profile: { tier: 'platinum' } };
      const result = resolveTierBenefits(memberData);

      expect(result).toHaveProperty('tier', 'platinum');
      expect(result).toHaveProperty('config');
      expect(result.config).toEqual({
        multiplier: 3.0,
        annualBonus: 500,
        minSpend: 5000,
      });
    });

    it('should resolve the correct config for each tier', () => {
      const gold = resolveTierBenefits({ profile: { tier: 'gold' } });
      expect(gold.config.multiplier).toBe(2.0);
      expect(gold.config.annualBonus).toBe(250);

      const silver = resolveTierBenefits({ profile: { tier: 'silver' } });
      expect(silver.config.multiplier).toBe(1.0);
      expect(silver.config.annualBonus).toBe(100);
    });

    it('should use requestedTier over memberData.profile.tier when provided', () => {
      const memberData = { profile: { tier: 'silver' } };
      const result = resolveTierBenefits(memberData, 'gold');

      expect(result.tier).toBe('gold');
      expect(result.config.multiplier).toBe(2.0);
    });

    it('should return null for an unknown tier', () => {
      const memberData = { profile: { tier: 'diamond' } };
      const result = resolveTierBenefits(memberData);

      expect(result).toBeNull();
    });
  });

  describe('calculateRewardsBalance', () => {
    it('should calculate rewards for a platinum member without throwing', () => {
      const memberData = {
        rewards: { currentPoints: 12450, lifetimeSpend: 28700 },
      };
      const tierBenefits = resolveTierBenefits({ profile: { tier: 'platinum' } });

      const result = calculateRewardsBalance(memberData, tierBenefits);

      expect(result.points).toBe(12450);
      expect(result.tierMultiplier).toBe(3.0);
      expect(parseFloat(result.baseRewards)).toBeCloseTo(12450 * 0.01 * 3.0);
      expect(parseFloat(result.annualBonus)).toBe(500);
      expect(parseFloat(result.rewardsBalance)).toBeCloseTo(12450 * 0.01 * 3.0 + 500);
    });

    it('should calculate rewards for all tiers', () => {
      const memberData = {
        rewards: { currentPoints: 1000, lifetimeSpend: 3000 },
      };

      for (const tier of ['platinum', 'gold', 'silver']) {
        const tierBenefits = resolveTierBenefits({ profile: { tier } });
        expect(() => calculateRewardsBalance(memberData, tierBenefits)).not.toThrow();
      }
    });

    it('should include nextTierSpend in the result', () => {
      const memberData = {
        rewards: { currentPoints: 2340, lifetimeSpend: 5100 },
      };
      const tierBenefits = resolveTierBenefits({ profile: { tier: 'silver' } });
      const result = calculateRewardsBalance(memberData, tierBenefits);

      expect(result.nextTierSpend).toBeDefined();
      expect(result.nextTierSpend.nextTier).toBe('gold');
    });
  });

  describe('findMember', () => {
    it('should find a member by email', () => {
      const result = findMember({ email: 'alice.chen@example.com' });
      expect(result).not.toBeNull();
      expect(result.profile.id).toBe('RL-10042891');
      expect(result.profile.tier).toBe('platinum');
    });

    it('should find a member by memberId', () => {
      const result = findMember({ memberId: 'RL-10042891' });
      expect(result).not.toBeNull();
      expect(result.profile.email).toBe('alice.chen@example.com');
    });

    it('should return null for a non-existent member', () => {
      const result = findMember({ email: 'nobody@example.com' });
      expect(result).toBeNull();
    });
  });

  describe('end-to-end: findMember → resolveTierBenefits → calculateRewardsBalance', () => {
    it('should complete the full rewards lookup chain for a platinum member', () => {
      const memberData = findMember({ email: 'alice.chen@example.com' });
      expect(memberData).not.toBeNull();

      const tierBenefits = resolveTierBenefits(memberData);
      expect(tierBenefits).not.toBeNull();
      expect(tierBenefits.config).toBeDefined();

      const balance = calculateRewardsBalance(memberData, tierBenefits);
      expect(parseFloat(balance.rewardsBalance)).toBeGreaterThan(0);
    });
  });
});
