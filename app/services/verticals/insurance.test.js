// Mock uuid before importing insurance module (uuid uses ESM exports)
jest.mock('uuid', () => ({
  v4: () => 'test-claim-id-1234',
}));

const { processClaim, POLICIES, CLAIM_TYPES } = require('./insurance');

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

describe('processClaim', () => {
  it('should successfully process a valid claim with correct coverage limits', async () => {
    const result = await processClaim({
      policyId: 'POL-5001',
      claimType: 'collision',
      amount: 2500,
      description: 'Vehicle damage from collision',
    });

    expect(result.success).toBe(true);
    expect(result.claimId).toBeDefined();
    expect(result.policyId).toBe('POL-5001');
    expect(result.claimAmount).toBe(2500);
    expect(result.deductible).toBe(500);
    expect(result.payout).toBe(2000);
    expect(result.status).toBe('approved');
    expect(result.processedAt).toBeDefined();
  });

  it('should cap payout at maxPayout when claim exceeds coverage', async () => {
    const result = await processClaim({
      policyId: 'POL-5001',
      claimType: 'collision',
      amount: 100000,
      description: 'Major collision',
    });

    expect(result.success).toBe(true);
    expect(result.payout).toBe(50000);
  });

  it('should correctly process claims for different policies', async () => {
    const result = await processClaim({
      policyId: 'POL-5002',
      claimType: 'weather',
      amount: 50000,
      description: 'Storm damage to home',
    });

    expect(result.success).toBe(true);
    expect(result.deductible).toBe(1000);
    expect(result.payout).toBe(49000);
  });

  it('should throw when policy is not found (null result)', async () => {
    await expect(
      processClaim({
        policyId: 'POL-NONEXISTENT',
        claimType: 'collision',
        amount: 5000,
        description: 'Test claim',
      })
    ).rejects.toThrow(TypeError);
  });

  it('should handle zero-deductible policies correctly', async () => {
    const result = await processClaim({
      policyId: 'POL-5003',
      claimType: 'medical',
      amount: 10000,
      description: 'Medical expense',
    });

    expect(result.success).toBe(true);
    expect(result.deductible).toBe(0);
    expect(result.payout).toBe(10000);
  });
});

describe('POLICIES data', () => {
  it('should have coverage data for all policies', () => {
    POLICIES.forEach((policy) => {
      expect(policy.coverage).toBeDefined();
      expect(typeof policy.coverage.maxPayout).toBe('number');
      expect(typeof policy.coverage.liability).toBe('number');
      expect(typeof policy.deductible).toBe('number');
    });
  });
});

describe('CLAIM_TYPES data', () => {
  it('should have valid claim type entries', () => {
    CLAIM_TYPES.forEach((ct) => {
      expect(ct.id).toBeDefined();
      expect(ct.label).toBeDefined();
      expect(ct.policyType).toBeDefined();
    });
  });
});
