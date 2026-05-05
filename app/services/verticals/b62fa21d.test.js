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

const { processRewardsLookup } = require('./b62fa21d');

describe('b62fa21d rewards lookup', () => {
  describe('processRewardsLookup', () => {
    it('should successfully process a platinum tier rewards lookup', async () => {
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

    it('should successfully process a gold tier rewards lookup', async () => {
      const result = await processRewardsLookup({
        email: 'james.wright@example.com',
        memberId: 'RL-10098234',
        tier: 'gold',
      });

      expect(result.success).toBe(true);
      expect(result.tier).toBe('gold');
    });

    it('should successfully process a silver tier rewards lookup', async () => {
      const result = await processRewardsLookup({
        email: 'sofia.martinez@example.com',
        memberId: 'RL-10071562',
        tier: 'silver',
      });

      expect(result.success).toBe(true);
      expect(result.tier).toBe('silver');
    });

    it('should use the member profile tier when no tier is specified in request', async () => {
      const result = await processRewardsLookup({
        email: 'alice.chen@example.com',
        memberId: 'RL-10042891',
      });

      expect(result.success).toBe(true);
      expect(result.tier).toBe('platinum');
    });

    it('should throw MemberNotFoundError for unknown member', async () => {
      await expect(
        processRewardsLookup({
          email: 'unknown@example.com',
          memberId: 'RL-00000000',
        })
      ).rejects.toThrow('Member not found');
    });

    it('should apply correct tier multiplier and annual bonus for platinum', async () => {
      const result = await processRewardsLookup({
        email: 'alice.chen@example.com',
        memberId: 'RL-10042891',
        tier: 'platinum',
      });

      const expectedPointsValue = 12450 * 0.01;
      const expectedBase = expectedPointsValue * 3.0;
      const expectedTotal = expectedBase + 500;

      expect(result.rewardsBalance).toBe(expectedTotal.toFixed(2));
    });
  });
});
