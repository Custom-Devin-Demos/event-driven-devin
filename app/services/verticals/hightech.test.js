// Mock uuid before importing the module under test (ESM compatibility)
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock dependencies to isolate unit tests
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

const { provisionLicense, PLAN_CONFIGS } = require('./hightech');

describe('provisionLicense', () => {
  it('should successfully provision a license for the enterprise plan', async () => {
    const result = await provisionLicense({
      orgName: 'New Department',
      planName: 'enterprise',
      seats: 15,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.licenseId).toBeDefined();
    expect(result.plan).toBe('enterprise');
    expect(result.seats).toBe(15);
    expect(result.pricePerSeat).toBe(6);
    expect(result.monthlyCost).toBe(90);
    expect(result.billingAmount).toBe(90);
    expect(result.billingCycle).toBe('monthly');
    expect(result.features).toEqual(['basic', 'analytics', 'sso', 'audit']);
    expect(result.supportLevel).toBe('priority');
    expect(result.status).toBe('provisioned');
  });

  it('should correctly compute annual billing with 20% discount', async () => {
    const result = await provisionLicense({
      orgName: 'Test Corp',
      planName: 'professional',
      seats: 10,
      billingCycle: 'annual',
    });

    expect(result.success).toBe(true);
    expect(result.pricePerSeat).toBe(8);
    expect(result.monthlyCost).toBe(80);
    // annual = monthlyCost * 12 * 0.8 = 80 * 12 * 0.8 = 768
    expect(result.billingAmount).toBe(768);
    expect(result.billingCycle).toBe('annual');
  });

  it('should throw an error for an unknown plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Corp',
        planName: 'nonexistent',
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow('Unknown plan: nonexistent');
  });

  it('should handle case-insensitive plan names when lowercased by the route handler', async () => {
    // The route handler now lowercases plan names before passing to provisionLicense.
    // This test verifies that lowercase plan names resolve correctly.
    const result = await provisionLicense({
      orgName: 'Case Test',
      planName: 'starter',
      seats: 3,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.pricePerSeat).toBe(10);
    expect(result.monthlyCost).toBe(30);
  });

  it('should throw for a capitalized plan name that does not match lowercase keys', async () => {
    // This reproduces the original Sentry bug: if a capitalized plan name
    // bypasses the route handler's toLowerCase(), it should fail gracefully
    // instead of crashing with TypeError on undefined.pricePerSeat
    await expect(
      provisionLicense({
        orgName: 'Uppercase Corp',
        planName: 'Professional',
        seats: 10,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow('Unknown plan: Professional');
  });

  it('should return withinLimit=true for unlimited seat plans', async () => {
    const result = await provisionLicense({
      orgName: 'Big Corp',
      planName: 'enterprise',
      seats: 500,
      billingCycle: 'monthly',
    });

    expect(result.withinLimit).toBe(true);
  });

  it('should return withinLimit=false when seats exceed plan limit', async () => {
    const result = await provisionLicense({
      orgName: 'Over Limit Corp',
      planName: 'starter',
      seats: 10,
      billingCycle: 'monthly',
    });

    // starter plan has max 5 seats
    expect(result.withinLimit).toBe(false);
  });
});
