// Mock uuid before requiring the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-license-id-1234',
}));

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
  it('should successfully provision an enterprise license', async () => {
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
    expect(result.status).toBe('provisioned');
    expect(result.licenseId).toBeDefined();
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
    expect(result.monthlyCost).toBe(80); // 10 * 8
    expect(result.billingAmount).toBe(768); // 80 * 12 * 0.8
    expect(result.billingCycle).toBe('annual');
  });

  it('should provision a starter plan within seat limits', async () => {
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

  it('should flag when seats exceed the plan limit', async () => {
    const result = await provisionLicense({
      orgName: 'Over Limit Corp',
      planName: 'starter',
      seats: 10,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.withinLimit).toBe(false); // starter max is 5
  });

  it('should throw when an invalid plan name is provided', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Plan Corp',
        planName: 'nonexistent',
        seats: 5,
        billingCycle: 'monthly',
      }),
    ).rejects.toThrow();
  });

  it('should throw when planName is undefined', async () => {
    await expect(
      provisionLicense({
        orgName: 'No Plan Corp',
        planName: undefined,
        seats: 5,
        billingCycle: 'monthly',
      }),
    ).rejects.toThrow();
  });

  it('should throw when planName is null', async () => {
    await expect(
      provisionLicense({
        orgName: 'Null Plan Corp',
        planName: null,
        seats: 5,
        billingCycle: 'monthly',
      }),
    ).rejects.toThrow();
  });

  it('should include all expected fields in the response', async () => {
    const result = await provisionLicense({
      orgName: 'Complete Corp',
      planName: 'enterprise',
      seats: 20,
      billingCycle: 'monthly',
    });

    expect(result).toHaveProperty('licenseId');
    expect(result).toHaveProperty('orgName', 'Complete Corp');
    expect(result).toHaveProperty('plan', 'enterprise');
    expect(result).toHaveProperty('seats', 20);
    expect(result).toHaveProperty('pricePerSeat');
    expect(result).toHaveProperty('monthlyCost');
    expect(result).toHaveProperty('billingAmount');
    expect(result).toHaveProperty('billingCycle', 'monthly');
    expect(result).toHaveProperty('features');
    expect(result).toHaveProperty('supportLevel');
    expect(result).toHaveProperty('withinLimit');
    expect(result).toHaveProperty('status', 'provisioned');
    expect(result).toHaveProperty('activatedAt');
  });
});

describe('PLAN_CONFIGS', () => {
  it('should have pricePerSeat defined for all plans', () => {
    for (const [_planName, config] of Object.entries(PLAN_CONFIGS)) {
      expect(config.pricePerSeat).toBeDefined();
      expect(typeof config.pricePerSeat).toBe('number');
      expect(config.pricePerSeat).toBeGreaterThan(0);
    }
  });

  it('should have all required fields for every plan', () => {
    const requiredFields = ['seats', 'pricePerSeat', 'features', 'supportLevel', 'tier'];
    for (const [_planName, config] of Object.entries(PLAN_CONFIGS)) {
      for (const field of requiredFields) {
        expect(config).toHaveProperty(field);
      }
    }
  });
});
