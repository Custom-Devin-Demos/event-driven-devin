const { provisionLicense, PLAN_CONFIGS } = require('./hightech');

// Mock dependencies
jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));
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
  it('should provision an enterprise license successfully', async () => {
    const result = await provisionLicense({
      orgName: 'New Department',
      planName: 'enterprise',
      seats: 15,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.licenseId).toBe('test-uuid-1234');
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

  it('should calculate annual billing with 20% discount', async () => {
    const result = await provisionLicense({
      orgName: 'Annual Org',
      planName: 'professional',
      seats: 10,
      billingCycle: 'annual',
    });

    expect(result.success).toBe(true);
    expect(result.pricePerSeat).toBe(8);
    expect(result.monthlyCost).toBe(80);
    // Annual = monthly * 12 * 0.8
    expect(result.billingAmount).toBe(768);
    expect(result.billingCycle).toBe('annual');
  });

  it('should provision a starter plan successfully', async () => {
    const result = await provisionLicense({
      orgName: 'Small Team',
      planName: 'starter',
      seats: 3,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.pricePerSeat).toBe(10);
    expect(result.monthlyCost).toBe(30);
    expect(result.billingAmount).toBe(30);
    expect(result.withinLimit).toBe(true);
  });

  it('should set withinLimit to false when seats exceed plan limit', async () => {
    const result = await provisionLicense({
      orgName: 'Over Limit Org',
      planName: 'starter',
      seats: 10,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.withinLimit).toBe(false);
  });

  it('should throw TypeError when planName is invalid/undefined', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Org',
        planName: 'nonexistent',
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow(TypeError);
  });

  it('should throw TypeError when planName is null', async () => {
    await expect(
      provisionLicense({
        orgName: 'Null Plan Org',
        planName: null,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow(TypeError);
  });

  it('should throw TypeError when planName is undefined', async () => {
    await expect(
      provisionLicense({
        orgName: 'Undefined Plan Org',
        planName: undefined,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow(TypeError);
  });
});

describe('PLAN_CONFIGS', () => {
  it('should have enterprise plan with pricePerSeat defined', () => {
    expect(PLAN_CONFIGS.enterprise).toBeDefined();
    expect(PLAN_CONFIGS.enterprise.pricePerSeat).toBe(6);
  });

  it('should have all required fields for every plan', () => {
    for (const [planName, config] of Object.entries(PLAN_CONFIGS)) {
      expect(config.pricePerSeat).toBeDefined();
      expect(typeof config.pricePerSeat).toBe('number');
      expect(config.seats).toBeDefined();
      expect(config.features).toBeDefined();
      expect(Array.isArray(config.features)).toBe(true);
      expect(config.supportLevel).toBeDefined();
    }
  });
});
