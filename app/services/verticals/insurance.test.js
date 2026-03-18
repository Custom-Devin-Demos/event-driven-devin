// Mock uuid before requiring the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-claim-uuid-1234',
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
    it('should successfully process a claim for a valid policy (POL-5001)', async () => {
      const result = await processClaim({
        policyId: 'POL-5001',
        claimType: 'collision',
        amount: 5000,
        description: 'Vehicle damage from collision',
      });

      expect(result.success).toBe(true);
      expect(result.policyId).toBe('POL-5001');
      expect(result.claimAmount).toBe(5000);
      expect(result.deductible).toBe(500);
      // net claimable = 5000 - 500 = 4500, maxPayout = 50000, so payout = 4500
      expect(result.payout).toBe(4500);
      expect(result.status).toBe('approved');
      expect(result.claimId).toBeDefined();
      expect(result.processedAt).toBeDefined();
    });

    it('should successfully process a claim for POL-5002 (home policy)', async () => {
      const result = await processClaim({
        policyId: 'POL-5002',
        claimType: 'weather',
        amount: 10000,
        description: 'Storm damage to roof',
      });

      expect(result.success).toBe(true);
      expect(result.policyId).toBe('POL-5002');
      expect(result.deductible).toBe(1000);
      // net claimable = 10000 - 1000 = 9000, maxPayout = 250000, so payout = 9000
      expect(result.payout).toBe(9000);
    });

    it('should cap payout at maxPayout when claim exceeds coverage', async () => {
      const result = await processClaim({
        policyId: 'POL-5001',
        claimType: 'collision',
        amount: 100000,
        description: 'Major accident',
      });

      expect(result.success).toBe(true);
      // net claimable = 100000 - 500 = 99500, maxPayout = 50000, so payout = 50000
      expect(result.payout).toBe(50000);
    });

    it('should throw an error for an unknown policy ID', async () => {
      await expect(
        processClaim({
          policyId: 'POL-INVALID',
          claimType: 'collision',
          amount: 5000,
        }),
      ).rejects.toThrow();
    });

    it('should handle all defined policies without errors', async () => {
      for (const policy of POLICIES) {
        const result = await processClaim({
          policyId: policy.id,
          claimType: 'collision',
          amount: 1000,
        });
        expect(result.success).toBe(true);
        expect(result.policyId).toBe(policy.id);
      }
    });

    it('should correctly compute deductible for zero-deductible policy (POL-5003)', async () => {
      const result = await processClaim({
        policyId: 'POL-5003',
        claimType: 'medical',
        amount: 2000,
      });

      expect(result.success).toBe(true);
      expect(result.deductible).toBe(0);
      // net claimable = 2000 - 0 = 2000, maxPayout = 500000, so payout = 2000
      expect(result.payout).toBe(2000);
    });
  });

  describe('POLICIES', () => {
    it('should have coverage data for every policy', () => {
      for (const policy of POLICIES) {
        expect(policy.coverage).toBeDefined();
        expect(typeof policy.coverage.maxPayout).toBe('number');
        expect(typeof policy.coverage.liability).toBe('number');
        expect(typeof policy.deductible).toBe('number');
      }
    });
  });

  describe('CLAIM_TYPES', () => {
    it('should have valid claim type definitions', () => {
      expect(CLAIM_TYPES.length).toBeGreaterThan(0);
      for (const ct of CLAIM_TYPES) {
        expect(ct.id).toBeDefined();
        expect(ct.label).toBeDefined();
        expect(ct.policyType).toBeDefined();
      }
    });
  });
});
