// Mock uuid before requiring the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-claim-uuid',
}));

// Mock telemetry dependencies to isolate unit tests
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

const { processClaim, POLICIES, CLAIM_TYPES } = require('./insurance');

describe('insurance service', () => {
  describe('processClaim', () => {
    it('should successfully process a claim for POL-5001 with correct payout', async () => {
      const result = await processClaim({
        policyId: 'POL-5001',
        claimType: 'collision',
        amount: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.policyId).toBe('POL-5001');
      expect(result.claimAmount).toBe(5000);
      expect(result.deductible).toBe(500);
      expect(result.payout).toBe(4500);
      expect(result.status).toBe('approved');
      expect(result.claimId).toBeDefined();
      expect(result.processedAt).toBeDefined();
    });

    it('should cap payout at maxPayout when claim exceeds coverage', async () => {
      const result = await processClaim({
        policyId: 'POL-5001',
        claimType: 'collision',
        amount: 100000,
      });

      expect(result.success).toBe(true);
      // maxPayout for POL-5001 is 50000, deductible is 500
      // netClaimable = 100000 - 500 = 99500, capped at 50000
      expect(result.payout).toBe(50000);
      expect(result.deductible).toBe(500);
    });

    it('should process claims for different policies correctly', async () => {
      const result = await processClaim({
        policyId: 'POL-5002',
        claimType: 'weather',
        amount: 10000,
      });

      expect(result.success).toBe(true);
      expect(result.policyId).toBe('POL-5002');
      // POL-5002 deductible is 1000
      expect(result.deductible).toBe(1000);
      // netClaimable = 10000 - 1000 = 9000, maxPayout is 250000
      expect(result.payout).toBe(9000);
    });

    it('should throw when given an invalid/unknown policyId', async () => {
      await expect(
        processClaim({
          policyId: 'POL-INVALID',
          claimType: 'collision',
          amount: 5000,
        }),
      ).rejects.toThrow();
    });

    it('should throw when policyId is null', async () => {
      await expect(
        processClaim({
          policyId: null,
          claimType: 'collision',
          amount: 5000,
        }),
      ).rejects.toThrow();
    });

    it('should throw when policyId is undefined', async () => {
      await expect(
        processClaim({
          claimType: 'collision',
          amount: 5000,
        }),
      ).rejects.toThrow();
    });
  });

  describe('POLICIES data', () => {
    it('should have coverage data for all policies', () => {
      for (const policy of POLICIES) {
        expect(policy.coverage).toBeDefined();
        expect(typeof policy.coverage.maxPayout).toBe('number');
        expect(typeof policy.coverage.liability).toBe('number');
        expect(typeof policy.deductible).toBe('number');
      }
    });
  });
});
