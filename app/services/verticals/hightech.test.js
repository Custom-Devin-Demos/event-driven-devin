// Mock uuid before importing the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock dependencies
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
  it('should successfully provision a license with the enterprise plan', async () => {
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
    expect(result.status).toBe('provisioned');
    expect(result.licenseId).toBeDefined();
    expect(result.features).toEqual(['basic', 'analytics', 'sso', 'audit']);
    expect(result.supportLevel).toBe('priority');
  });

  it('should successfully provision a license with the starter plan', async () => {
    const result = await provisionLicense({
      orgName: 'Small Team',
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

  it('should successfully provision a license with the professional plan', async () => {
    const result = await provisionLicense({
      orgName: 'Mid Team',
      planName: 'professional',
      seats: 10,
      billingCycle: 'annual',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('professional');
    expect(result.pricePerSeat).toBe(8);
    expect(result.monthlyCost).toBe(80);
    // Annual billing: monthly * 12 * 0.8
    expect(result.billingAmount).toBe(768);
  });

  it('should throw an error for an invalid/unknown plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Test Org',
        planName: 'nonexistent-plan',
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should throw an error when planName is undefined', async () => {
    await expect(
      provisionLicense({
        orgName: 'Test Org',
        planName: undefined,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should throw an error when planName is null', async () => {
    await expect(
      provisionLicense({
        orgName: 'Test Org',
        planName: null,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should correctly compute annual billing with 20% discount', async () => {
    const result = await provisionLicense({
      orgName: 'Annual Org',
      planName: 'enterprise',
      seats: 10,
      billingCycle: 'annual',
    });

    // Enterprise: $6/seat, 10 seats = $60/mo, annual = $60 * 12 * 0.8 = $576
    expect(result.monthlyCost).toBe(60);
    expect(result.billingAmount).toBe(576);
  });

  it('should include pricePerSeat in the response for all valid plans', async () => {
    for (const planName of Object.keys(PLAN_CONFIGS)) {
      const result = await provisionLicense({
        orgName: 'Test',
        planName,
        seats: 1,
        billingCycle: 'monthly',
      });
      expect(result.pricePerSeat).toBe(PLAN_CONFIGS[planName].pricePerSeat);
    }
  });
});
