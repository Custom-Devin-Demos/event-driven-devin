jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));
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

const {
  processRewardsLookup,
} = require('./b62fa21d');

describe('b62fa21d rewards vertical', () => {
  describe('processRewardsLookup', () => {
    it('should return rewards balance for a platinum-tier member', async () => {
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

    it('should return rewards balance for a gold-tier member', async () => {
      const result = await processRewardsLookup({
        email: 'james.wright@example.com',
        memberId: 'RL-10098234',
        tier: 'gold',
      });

      expect(result.success).toBe(true);
      expect(result.tier).toBe('gold');
      expect(result.member).toBe('James Wright');
      expect(parseFloat(result.rewardsBalance)).toBeGreaterThan(0);
    });

    it('should return rewards balance for a silver-tier member', async () => {
      const result = await processRewardsLookup({
        email: 'sofia.martinez@example.com',
        memberId: 'RL-10071562',
        tier: 'silver',
      });

      expect(result.success).toBe(true);
      expect(result.tier).toBe('silver');
      expect(result.member).toBe('Sofia Martinez');
      expect(parseFloat(result.rewardsBalance)).toBeGreaterThan(0);
    });

    it('should throw for an unknown member', async () => {
      await expect(
        processRewardsLookup({
          email: 'nobody@example.com',
          memberId: 'RL-00000000',
          tier: 'gold',
        }),
      ).rejects.toThrow('Member not found');
    });

    it('should handle missing tier by falling back to the member profile tier', async () => {
      const result = await processRewardsLookup({
        email: 'alice.chen@example.com',
        memberId: 'RL-10042891',
      });

      expect(result.success).toBe(true);
      expect(result.tier).toBe('platinum');
    });
  });
});
