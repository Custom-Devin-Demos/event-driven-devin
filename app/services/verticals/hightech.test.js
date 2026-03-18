const { provisionLicense, PLAN_CONFIGS } = require('./hightech');

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

describe('provisionLicense', () => {
  it('should provision a license for a valid enterprise plan', async () => {
    const result = await provisionLicense({
      orgName: 'Test Org',
      planName: 'enterprise',
      seats: 15,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('enterprise');
    expect(result.seats).toBe(15);
    expect(result.pricePerSeat).toBe(6);
    expect(result.monthlyCost).toBe(90);
    expect(result.billingAmount).toBe(90);
    expect(result.status).toBe('provisioned');
    expect(result.licenseId).toBeDefined();
    expect(result.features).toEqual(['basic', 'analytics', 'sso', 'audit']);
    expect(result.supportLevel).toBe('priority');
  });

  it('should provision a license for the starter plan', async () => {
    const result = await provisionLicense({
      orgName: 'Small Org',
      planName: 'starter',
      seats: 3,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('starter');
    expect(result.pricePerSeat).toBe(10);
    expect(result.monthlyCost).toBe(30);
    expect(result.billingAmount).toBe(30);
  });

  it('should apply annual billing discount (20% off)', async () => {
    const result = await provisionLicense({
      orgName: 'Annual Org',
      planName: 'professional',
      seats: 10,
      billingCycle: 'annual',
    });

    expect(result.success).toBe(true);
    // monthly cost = 10 seats * $8/seat = $80
    expect(result.monthlyCost).toBe(80);
    // annual billing = $80 * 12 * 0.8 = $768
    expect(result.billingAmount).toBe(768);
    expect(result.billingCycle).toBe('annual');
  });

  it('should throw when plan name is invalid (does not exist in PLAN_CONFIGS)', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Org',
        planName: 'nonexistent',
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should throw when plan name has trailing whitespace and is not trimmed', async () => {
    // This reproduces the original bug: 'enterprise ' (with trailing space)
    // The service function receives the plan name as-is; trimming should happen in the route
    await expect(
      provisionLicense({
        orgName: 'Whitespace Org',
        planName: 'enterprise ',
        seats: 15,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should handle all valid plan names', async () => {
    for (const planName of Object.keys(PLAN_CONFIGS)) {
      const result = await provisionLicense({
        orgName: `Org for ${planName}`,
        planName,
        seats: 1,
        billingCycle: 'monthly',
      });
      expect(result.success).toBe(true);
      expect(result.plan).toBe(planName);
      expect(result.pricePerSeat).toBe(PLAN_CONFIGS[planName].pricePerSeat);
    }
  });
});
