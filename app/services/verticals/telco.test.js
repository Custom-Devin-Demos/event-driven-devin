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
    expect(result.newMonthlyRate).toBe(49.99);
    expect(result.newPlan).toBe('PLUS');
    expect(result.previousPlan).toBe('BASIC');
    expect(result.status).toBe('upgraded');
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
    expect(result.newDataGB).toBe('Unlimited');
    expect(result.previousPlan).toBe('FAMILY-PLUS');
    expect(result.newPlan).toBe('UNLIMITED');
  });

  it('should throw an error for an unknown plan code', async () => {
    await expect(
      upgradePlan({
        accountId: 'CUST-3001',
        currentPlanCode: 'UNKNOWN-99',
        targetPlanCode: 'PLUS-24',
        billingDay: 15,
      }),
    ).rejects.toThrow('Unknown plan code: UNKNOWN-99');
  });

  it('should throw an error when target plan code is invalid', async () => {
    await expect(
      upgradePlan({
        accountId: 'CUST-3001',
        currentPlanCode: 'BASIC-12',
        targetPlanCode: 'NONEXISTENT-12',
        billingDay: 15,
      }),
    ).rejects.toThrow('Unknown plan code: NONEXISTENT-12');
  });

  it('should include proration charge in the result', async () => {
    const result = await upgradePlan({
      accountId: 'CUST-3001',
      currentPlanCode: 'BASIC-12',
      targetPlanCode: 'ULTRA-36',
      billingDay: 15,
    });

    expect(result.success).toBe(true);
    expect(result.prorationCharge).toBeDefined();
    expect(typeof result.prorationCharge).toBe('number');
    expect(result.newMonthlyRate).toBe(79.99);
  });
});
