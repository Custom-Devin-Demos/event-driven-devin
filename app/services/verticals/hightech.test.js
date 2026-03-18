// Mock uuid before importing the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { provisionLicense } = require('./hightech');

// Mock telemetry dependencies to avoid side effects in tests
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

describe('provisionLicense', () => {
  it('should succeed for the "enterprise" plan (original failure condition)', async () => {
    const result = await provisionLicense({
      orgName: 'New Department',
      planName: 'enterprise',
      seats: 15,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('enterprise');
    expect(result.seats).toBe(15);
    expect(result.monthlyCost).toBe(90); // 15 * 6 = 90
    expect(result.billingAmount).toBe(90); // monthly billing
    expect(result.features).toEqual(['basic', 'analytics', 'sso', 'audit']);
    expect(result.supportLevel).toBe('priority');
    expect(result.status).toBe('provisioned');
  });

  it('should handle case-insensitive plan names (e.g. "Professional")', async () => {
    const result = await provisionLicense({
      orgName: 'Test Org',
      planName: 'Professional',
      seats: 10,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('Professional');
    expect(result.monthlyCost).toBe(80); // 10 * 8 = 80
    expect(result.billingAmount).toBe(80);
  });

  it('should handle uppercase plan names (e.g. "STARTER")', async () => {
    const result = await provisionLicense({
      orgName: 'Test Org',
      planName: 'STARTER',
      seats: 3,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.monthlyCost).toBe(30); // 3 * 10 = 30
  });

  it('should apply annual billing discount correctly', async () => {
    const result = await provisionLicense({
      orgName: 'Annual Org',
      planName: 'enterprise',
      seats: 10,
      billingCycle: 'annual',
    });

    expect(result.success).toBe(true);
    expect(result.monthlyCost).toBe(60); // 10 * 6 = 60
    expect(result.billingAmount).toBe(576); // 60 * 12 * 0.8 = 576
    expect(result.billingCycle).toBe('annual');
  });

  it('should handle plan name with trailing whitespace (e.g. "enterprise ")', async () => {
    const result = await provisionLicense({
      orgName: 'Whitespace Org',
      planName: 'enterprise ',
      seats: 10,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.monthlyCost).toBe(60); // 10 * 6 = 60
    expect(result.pricePerSeat).toBe(6);
  });

  it('should throw for an invalid/unknown plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Org',
        planName: 'nonexistent-plan',
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow();
  });

  it('should include all expected fields in the response', async () => {
    const result = await provisionLicense({
      orgName: 'Field Check Org',
      planName: 'starter',
      seats: 2,
      billingCycle: 'monthly',
    });

    expect(result).toHaveProperty('licenseId');
    expect(result).toHaveProperty('orgName', 'Field Check Org');
    expect(result).toHaveProperty('plan', 'starter');
    expect(result).toHaveProperty('seats', 2);
    expect(result).toHaveProperty('withinLimit');
    expect(result).toHaveProperty('features');
    expect(result).toHaveProperty('supportLevel');
    expect(result).toHaveProperty('monthlyCost');
    expect(result).toHaveProperty('billingAmount');
    expect(result).toHaveProperty('billingCycle');
    expect(result).toHaveProperty('status', 'provisioned');
    expect(result).toHaveProperty('activatedAt');
  });
});
