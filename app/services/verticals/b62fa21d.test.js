/**
 * Regression tests for the b62fa21d loyalty rewards vertical.
 *
 * These tests cover the bug that caused:
 *   TypeError: Cannot read properties of undefined (reading 'multiplier')
 * when a platinum-tier member looked up their rewards balance.
 *
 * Root cause: the "platinum" entry in TIER_BENEFITS was missing the nested
 * `config` wrapper, so `tierBenefits.config` was undefined.
 */

jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));
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
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const { processRewardsLookup, MEMBERS, TIER_BENEFITS } = require('./b62fa21d');

describe('b62fa21d loyalty rewards vertical', () => {
  describe('TIER_BENEFITS data structure', () => {
    it('should have a config object with multiplier for every tier', () => {
      for (const [tierName, tier] of Object.entries(TIER_BENEFITS)) {
        expect(tier.config).toBeDefined();
        expect(typeof tier.config.multiplier).toBe('number');
        expect(typeof tier.config.annualBonus).toBe('number');
      }
    });

    it('should have config.multiplier defined for the platinum tier specifically', () => {
      const platinum = TIER_BENEFITS.platinum;
      expect(platinum).toBeDefined();
      expect(platinum.config).toBeDefined();
      expect(platinum.config.multiplier).toBe(3.0);
      expect(platinum.config.annualBonus).toBe(1000);
    });
  });

  describe('processRewardsLookup', () => {
    it('should succeed for a platinum-tier member (original failure condition)', async () => {
      const result = await processRewardsLookup({
        email: 'alice.chen@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.tier).toBe('platinum');
      expect(result.balance).toBeDefined();
      expect(result.balance.tierMultiplier).toBe(3.0);
      expect(result.balance.annualBonus).toBe(1000);
      expect(typeof result.balance.pointsValue).toBe('number');
    });

    it('should succeed for a gold-tier member', async () => {
      const result = await processRewardsLookup({
        email: 'james.wilson@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.tier).toBe('gold');
      expect(result.balance.tierMultiplier).toBe(2.0);
    });

    it('should succeed for a silver-tier member', async () => {
      const result = await processRewardsLookup({
        email: 'maria.santos@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.tier).toBe('silver');
      expect(result.balance.tierMultiplier).toBe(1.5);
    });

    it('should succeed for a bronze-tier member', async () => {
      const result = await processRewardsLookup({
        email: 'robert.kim@example.com',
      });

      expect(result.success).toBe(true);
      expect(result.tier).toBe('bronze');
      expect(result.balance.tierMultiplier).toBe(1.0);
    });

    it('should throw MEMBER_NOT_FOUND for an unknown email', async () => {
      await expect(
        processRewardsLookup({ email: 'unknown@example.com' }),
      ).rejects.toThrow('No rewards member found for email');
    });

    it('should handle case-insensitive email lookup', async () => {
      const result = await processRewardsLookup({
        email: 'ALICE.CHEN@EXAMPLE.COM',
      });

      expect(result.success).toBe(true);
      expect(result.tier).toBe('platinum');
    });

    it('should include required fields in the response', async () => {
      const result = await processRewardsLookup({
        email: 'alice.chen@example.com',
      });

      expect(result).toHaveProperty('lookupId');
      expect(result).toHaveProperty('memberId', 'RL-10042891');
      expect(result).toHaveProperty('memberName', 'Alice Chen');
      expect(result).toHaveProperty('tierLabel', 'Platinum');
      expect(result).toHaveProperty('memberSince');
      expect(result).toHaveProperty('processedAt');
    });
  });
});
