const { provisionLicense, PLAN_CONFIGS } = require('./hightech');

// Mock dependencies to isolate unit tests
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
  const validData = {
    orgName: 'Test Org',
    planName: 'enterprise',
    seats: 15,
    billingCycle: 'monthly',
  };

  it('should provision a license for the enterprise plan successfully', async () => {
    const result = await provisionLicense(validData);

    expect(result.success).toBe(true);
    expect(result.licenseId).toBe('test-uuid-1234');
    expect(result.plan).toBe('enterprise');
    expect(result.seats).toBe(15);
    expect(result.pricePerSeat).toBe(6);
    expect(result.monthlyCost).toBe(90); // 15 * 6
    expect(result.billingAmount).toBe(90);
    expect(result.features).toEqual(['basic', 'analytics', 'sso', 'audit']);
    expect(result.supportLevel).toBe('priority');
    expect(result.status).toBe('provisioned');
  });

  it('should handle annual billing with 20% discount', async () => {
    const result = await provisionLicense({ ...validData, billingCycle: 'annual' });

    expect(result.monthlyCost).toBe(90); // 15 * 6
    expect(result.billingAmount).toBe(864); // 90 * 12 * 0.8
  });

  it('should provision all valid plan names', async () => {
    for (const planName of Object.keys(PLAN_CONFIGS)) {
      const result = await provisionLicense({ ...validData, planName });
      expect(result.success).toBe(true);
      expect(result.plan).toBe(planName);
      expect(result.pricePerSeat).toBe(PLAN_CONFIGS[planName].pricePerSeat);
    }
  });

  it('should handle case-insensitive plan names', async () => {
    const result = await provisionLicense({ ...validData, planName: 'Enterprise' });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('Enterprise');
    expect(result.pricePerSeat).toBe(6);
    expect(result.monthlyCost).toBe(90);
  });

  it('should throw a descriptive error for an unknown plan name', async () => {
    await expect(
      provisionLicense({ ...validData, planName: 'nonexistent' })
    ).rejects.toThrow("Unknown plan: 'nonexistent'");
  });

  it('should throw an error when planName is undefined', async () => {
    await expect(
      provisionLicense({ ...validData, planName: undefined })
    ).rejects.toThrow('Unknown plan');
  });

  it('should throw an error when planName is null', async () => {
    await expect(
      provisionLicense({ ...validData, planName: null })
    ).rejects.toThrow('Unknown plan');
  });

  it('should throw an error when planName is an empty string', async () => {
    await expect(
      provisionLicense({ ...validData, planName: '' })
    ).rejects.toThrow('Unknown plan');
  });

  it('should return withinLimit=true for enterprise plan (unlimited seats)', async () => {
    const result = await provisionLicense({ ...validData, seats: 9999 });

    expect(result.withinLimit).toBe(true);
  });

  it('should return withinLimit=false when seats exceed plan limit', async () => {
    const result = await provisionLicense({
      ...validData,
      planName: 'starter',
      seats: 10, // starter max is 5
    });

    expect(result.withinLimit).toBe(false);
  });
});
