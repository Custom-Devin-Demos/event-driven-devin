// Mock uuid before importing the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { provisionLicense, PLAN_CONFIGS } = require('./hightech');

// Mock external dependencies
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
  it('should successfully provision a license for the enterprise plan', async () => {
    const result = await provisionLicense({
      orgName: 'New Department',
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
    expect(result.billingCycle).toBe('monthly');
    expect(result.status).toBe('provisioned');
    expect(result.features).toEqual(['basic', 'analytics', 'sso', 'audit']);
    expect(result.supportLevel).toBe('priority');
    expect(result.withinLimit).toBe(true);
    expect(result.licenseId).toBeDefined();
    expect(result.activatedAt).toBeDefined();
  });

  it('should correctly compute annual billing with 20% discount', async () => {
    const result = await provisionLicense({
      orgName: 'Annual Corp',
      planName: 'professional',
      seats: 10,
      billingCycle: 'annual',
    });

    expect(result.success).toBe(true);
    expect(result.pricePerSeat).toBe(8);
    expect(result.monthlyCost).toBe(80);
    // annual = monthly * 12 * 0.8
    expect(result.billingAmount).toBe(768);
    expect(result.billingCycle).toBe('annual');
  });

  it('should provision all valid plan types without error', async () => {
    const plans = Object.keys(PLAN_CONFIGS);

    for (const planName of plans) {
      const result = await provisionLicense({
        orgName: 'Test Org',
        planName,
        seats: 3,
        billingCycle: 'monthly',
      });

      expect(result.success).toBe(true);
      expect(result.plan).toBe(planName);
      expect(result.pricePerSeat).toBe(PLAN_CONFIGS[planName].pricePerSeat);
      expect(typeof result.monthlyCost).toBe('number');
      expect(typeof result.billingAmount).toBe('number');
      expect(result.monthlyCost).not.toBeNaN();
      expect(result.billingAmount).not.toBeNaN();
    }
  });

  it('should throw when given an invalid/unknown plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Org',
        planName: 'nonexistent-plan',
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should throw when planName is undefined', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Org',
        planName: undefined,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should throw when planName is null', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Org',
        planName: null,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should enforce seat limits for plans with a maximum', async () => {
    const result = await provisionLicense({
      orgName: 'Over Limit Inc',
      planName: 'starter',
      seats: 10,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.withinLimit).toBe(false);
  });

  it('should allow unlimited seats for enterprise plan', async () => {
    const result = await provisionLicense({
      orgName: 'Big Corp',
      planName: 'enterprise',
      seats: 1000,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.withinLimit).toBe(true);
  });
});
