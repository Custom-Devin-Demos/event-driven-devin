// Mock uuid before importing the module under test (ESM workaround)
jest.mock('uuid', () => ({
  v4: () => 'test-claim-id-1234',
}));

// Mock dependencies to isolate unit tests
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
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

const { processClaim, POLICIES } = require('./insurance');

describe('Insurance Service', () => {
  describe('processClaim', () => {
    it('should process a valid claim for POL-5001 without throwing', async () => {
      const result = await processClaim({
        policyId: 'POL-5001',
        claimType: 'collision',
        amount: 5000,
      });

      expect(result.success).toBe(true);
      expect(result.claimId).toBeDefined();
      expect(result.policyId).toBe('POL-5001');
      expect(result.status).toBe('approved');
    });

    it('should correctly calculate payout as amount minus deductible', async () => {
      // POL-5001 has deductible of 500
      const result = await processClaim({
        policyId: 'POL-5001',
        claimType: 'collision',
        amount: 5000,
      });

      expect(result.deductible).toBe(500);
      expect(result.estimatedPayout).toBe(4500); // 5000 - 500
    });

    it('should cap payout at maxPayout when claim exceeds coverage limit', async () => {
      // POL-5001 has maxPayout of 50000
      const result = await processClaim({
        policyId: 'POL-5001',
        claimType: 'collision',
        amount: 100000,
      });

      expect(result.estimatedPayout).toBe(50000);
    });

    it('should process claims for all valid policy IDs', async () => {
      for (const policy of POLICIES) {
        const result = await processClaim({
          policyId: policy.id,
          claimType: 'collision',
          amount: 1000,
        });

        expect(result.success).toBe(true);
        expect(result.policyId).toBe(policy.id);
        expect(result.estimatedPayout).toBeDefined();
        expect(typeof result.estimatedPayout).toBe('number');
      }
    });

    it('should throw when given an invalid/unknown policy ID', async () => {
      await expect(
        processClaim({
          policyId: 'POL-INVALID',
          claimType: 'collision',
          amount: 5000,
        })
      ).rejects.toThrow();
    });

    it('should throw when given a null policy ID', async () => {
      await expect(
        processClaim({
          policyId: null,
          claimType: 'collision',
          amount: 5000,
        })
      ).rejects.toThrow();
    });

    it('should throw when given an undefined policy ID', async () => {
      await expect(
        processClaim({
          policyId: undefined,
          claimType: 'collision',
          amount: 5000,
        })
      ).rejects.toThrow();
    });

    it('should return estimatedPayout field (not payout) for frontend compatibility', async () => {
      const result = await processClaim({
        policyId: 'POL-5001',
        claimType: 'collision',
        amount: 5000,
      });

      expect(result).toHaveProperty('estimatedPayout');
      expect(result).not.toHaveProperty('payout');
    });

    it('should handle zero-deductible policies correctly', async () => {
      // POL-5003 has deductible of 0
      const result = await processClaim({
        policyId: 'POL-5003',
        claimType: 'medical',
        amount: 2000,
      });

      expect(result.deductible).toBe(0);
      expect(result.estimatedPayout).toBe(2000);
    });
  });
});
