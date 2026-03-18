// Mock uuid before importing telco module (uuid is ESM-only)
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

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

const { upgradePlan, PLANS } = require('./telco');

describe('upgradePlan', () => {
  it('should successfully upgrade from BASIC-12 to PLUS-24', async () => {
    const result = await upgradePlan({
      accountId: 'CUST-3001',
      currentPlanCode: 'BASIC-12',
      targetPlanCode: 'PLUS-24',
      billingDay: 15,
    });

    expect(result.success).toBe(true);
    expect(result.newPlan).toBe('PLUS');
    expect(result.newMonthlyRate).toBe(49.99);
    expect(result.accountId).toBe('CUST-3001');
    expect(result.previousPlan).toBe('BASIC');
    expect(result.status).toBe('upgraded');
    expect(typeof result.prorationCharge).toBe('number');
  });

  it('should handle case-insensitive plan codes', async () => {
    const result = await upgradePlan({
      accountId: 'CUST-3001',
      currentPlanCode: 'basic-12',
      targetPlanCode: 'plus-24',
      billingDay: 15,
    });

    expect(result.success).toBe(true);
    expect(result.newMonthlyRate).toBe(49.99);
  });

  it('should handle multi-segment plan codes like FAMILY-PLUS-12', async () => {
    const result = await upgradePlan({
      accountId: 'CUST-3001',
      currentPlanCode: 'FAMILY-PLUS-12',
      targetPlanCode: 'UNLIMITED-24',
      billingDay: 15,
    });

    expect(result.success).toBe(true);
    expect(result.newMonthlyRate).toBe(119.99);
    expect(result.previousPlan).toBe('FAMILY-PLUS');
    expect(result.newPlan).toBe('UNLIMITED');
  });

  it('should handle case-insensitive multi-segment plan codes', async () => {
    const result = await upgradePlan({
      accountId: 'CUST-3001',
      currentPlanCode: 'family-plus-12',
      targetPlanCode: 'unlimited-24',
      billingDay: 15,
    });

    expect(result.success).toBe(true);
    expect(result.newMonthlyRate).toBe(119.99);
  });

  it('should throw a clear error for unknown current plan code', async () => {
    await expect(
      upgradePlan({
        accountId: 'CUST-3001',
        currentPlanCode: 'NONEXISTENT-99',
        targetPlanCode: 'PLUS-24',
        billingDay: 15,
      }),
    ).rejects.toThrow('Unknown current plan: NONEXISTENT-99');
  });

  it('should throw a clear error for unknown target plan code', async () => {
    await expect(
      upgradePlan({
        accountId: 'CUST-3001',
        currentPlanCode: 'BASIC-12',
        targetPlanCode: 'NONEXISTENT-99',
        billingDay: 15,
      }),
    ).rejects.toThrow('Unknown target plan: NONEXISTENT-99');
  });

  it('should use default billingDay of 15 when not provided', async () => {
    const result = await upgradePlan({
      accountId: 'CUST-3001',
      currentPlanCode: 'BASIC-12',
      targetPlanCode: 'ULTRA-36',
    });

    expect(result.success).toBe(true);
    expect(result.newMonthlyRate).toBe(79.99);
    expect(typeof result.prorationCharge).toBe('number');
  });

  it('should include all expected response fields', async () => {
    const result = await upgradePlan({
      accountId: 'CUST-3001',
      currentPlanCode: 'BASIC-12',
      targetPlanCode: 'PLUS-24',
      billingDay: 15,
    });

    expect(result).toHaveProperty('success', true);
    expect(result).toHaveProperty('upgradeId');
    expect(result).toHaveProperty('accountId');
    expect(result).toHaveProperty('previousPlan');
    expect(result).toHaveProperty('newPlan');
    expect(result).toHaveProperty('newTermMonths');
    expect(result).toHaveProperty('prorationCharge');
    expect(result).toHaveProperty('newMonthlyRate');
    expect(result).toHaveProperty('newDataGB');
    expect(result).toHaveProperty('effectiveDate');
    expect(result).toHaveProperty('status');
    expect(result).toHaveProperty('processedAt');
  });
});
