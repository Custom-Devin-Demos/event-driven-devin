// Mock uuid before importing telco module (uuid uses ESM exports)
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { upgradePlan, PLANS } = require('./telco');

// Mock dependencies to isolate unit tests
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

describe('upgradePlan', () => {
  it('should successfully upgrade from BASIC-12 to FAMILY-PLUS-12', async () => {
    const result = await upgradePlan({
      accountId: 'CUST-3001',
      currentPlanCode: 'BASIC-12',
      targetPlanCode: 'FAMILY-PLUS-12',
      billingDay: 15,
    });

    expect(result.success).toBe(true);
    expect(result.accountId).toBe('CUST-3001');
    expect(result.newMonthlyRate).toBe(99.99);
    expect(result.status).toBe('upgraded');
  });

  it('should handle lowercase plan codes (original bug: basic-12)', async () => {
    const result = await upgradePlan({
      accountId: 'CUST-3001',
      currentPlanCode: 'basic-12',
      targetPlanCode: 'family-plus-12',
      billingDay: 15,
    });

    expect(result.success).toBe(true);
    expect(result.newMonthlyRate).toBe(99.99);
  });

  it('should handle mixed-case plan codes', async () => {
    const result = await upgradePlan({
      accountId: 'CUST-3001',
      currentPlanCode: 'Basic-12',
      targetPlanCode: 'Plus-24',
      billingDay: 1,
    });

    expect(result.success).toBe(true);
    expect(result.newMonthlyRate).toBe(49.99);
  });

  it('should throw an error for an unknown current plan code', async () => {
    await expect(
      upgradePlan({
        accountId: 'CUST-3001',
        currentPlanCode: 'NONEXISTENT-99',
        targetPlanCode: 'BASIC-12',
        billingDay: 15,
      }),
    ).rejects.toThrow('Unknown current plan code: NONEXISTENT-99');
  });

  it('should throw an error for an unknown target plan code', async () => {
    await expect(
      upgradePlan({
        accountId: 'CUST-3001',
        currentPlanCode: 'BASIC-12',
        targetPlanCode: 'INVALID-PLAN-99',
        billingDay: 15,
      }),
    ).rejects.toThrow('Unknown target plan code: INVALID-PLAN-99');
  });

  it('should include proration charge in the result', async () => {
    const result = await upgradePlan({
      accountId: 'CUST-3002',
      currentPlanCode: 'PLUS-24',
      targetPlanCode: 'ULTRA-36',
      billingDay: 1,
    });

    expect(result.success).toBe(true);
    expect(typeof result.prorationCharge).toBe('number');
    expect(result.newMonthlyRate).toBe(79.99);
  });
});

describe('PLANS', () => {
  it('should contain plans with id and monthlyRate properties', () => {
    expect(PLANS.length).toBeGreaterThan(0);
    for (const plan of PLANS) {
      expect(plan).toHaveProperty('id');
      expect(plan).toHaveProperty('monthlyRate');
      expect(typeof plan.id).toBe('string');
      expect(typeof plan.monthlyRate).toBe('number');
    }
  });
});
