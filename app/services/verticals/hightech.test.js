// Mock uuid before importing hightech so the ESM module is never loaded
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
    expect(result.monthlyCost).toBe(90); // 15 * 6
    expect(result.billingAmount).toBe(90);
    expect(result.licenseId).toBeDefined();
    expect(result.features).toEqual(['basic', 'analytics', 'sso', 'audit']);
    expect(result.supportLevel).toBe('priority');
    expect(result.status).toBe('provisioned');
  });

  it('should compute annual billing correctly with 20% discount', async () => {
    const result = await provisionLicense({
      orgName: 'Annual Corp',
      planName: 'professional',
      seats: 10,
      billingCycle: 'annual',
    });

    expect(result.success).toBe(true);
    expect(result.pricePerSeat).toBe(8);
    expect(result.monthlyCost).toBe(80); // 10 * 8
    expect(result.billingAmount).toBe(768); // 80 * 12 * 0.8
    expect(result.billingCycle).toBe('annual');
  });

  it('should provision correctly for the starter plan', async () => {
    const result = await provisionLicense({
      orgName: 'Small Team',
      planName: 'starter',
      seats: 3,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.pricePerSeat).toBe(10);
    expect(result.monthlyCost).toBe(30); // 3 * 10
    expect(result.withinLimit).toBe(true);
  });

  it('should throw an error for an invalid plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Plan Corp',
        planName: 'nonexistent',
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should throw an error when planName is undefined', async () => {
    await expect(
      provisionLicense({
        orgName: 'No Plan Corp',
        planName: undefined,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should throw an error when planName is null', async () => {
    await expect(
      provisionLicense({
        orgName: 'Null Plan Corp',
        planName: null,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should include pricePerSeat in the response', async () => {
    const result = await provisionLicense({
      orgName: 'Price Check Corp',
      planName: 'unlimited',
      seats: 20,
      billingCycle: 'monthly',
    });

    expect(result.pricePerSeat).toBe(12);
    expect(typeof result.pricePerSeat).toBe('number');
  });
});

describe('PLAN_CONFIGS', () => {
  it('should have pricePerSeat defined for all plans', () => {
    for (const [_name, config] of Object.entries(PLAN_CONFIGS)) {
      expect(config.pricePerSeat).toBeDefined();
      expect(typeof config.pricePerSeat).toBe('number');
      expect(config.pricePerSeat).toBeGreaterThan(0);
    }
  });

  it('should contain the enterprise plan', () => {
    expect(PLAN_CONFIGS.enterprise).toBeDefined();
    expect(PLAN_CONFIGS.enterprise.pricePerSeat).toBe(6);
  });
});
