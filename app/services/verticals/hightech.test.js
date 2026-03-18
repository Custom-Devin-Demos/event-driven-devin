// Mock uuid before importing the module under test (uuid is ESM-only)
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock dependencies to isolate unit tests
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
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

// Require AFTER all mocks are set up
const { provisionLicense, PLAN_CONFIGS } = require('./hightech');

describe('provisionLicense', () => {
  it('should successfully provision a license with a lowercase plan name', async () => {
    const result = await provisionLicense({
      orgName: 'Test Org',
      planName: 'professional',
      seats: 10,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('professional');
    expect(result.seats).toBe(10);
    expect(result.pricePerSeat).toBe(8);
    expect(result.monthlyCost).toBe(80);
    expect(result.billingAmount).toBe(80);
    expect(result.features).toEqual(['basic', 'analytics']);
    expect(result.supportLevel).toBe('email');
    expect(result.status).toBe('provisioned');
    expect(result.licenseId).toBeDefined();
  });

  it('should throw a clear error for an unknown plan name (original bug: case mismatch)', async () => {
    // This was the original bug: "Professional" (capital P) was passed but
    // PLAN_CONFIGS uses lowercase keys. Before the fix, this returned undefined
    // config and crashed with "Cannot read properties of undefined (reading 'pricePerSeat')"
    await expect(
      provisionLicense({
        orgName: 'New Customer Inc',
        planName: 'Professional',
        seats: 10,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow(/Unknown plan: "Professional"/);
  });

  it('should throw a clear error for a completely invalid plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Test Org',
        planName: 'nonexistent-plan',
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow(/Unknown plan: "nonexistent-plan"/);
  });

  it('should throw a clear error when planName is undefined', async () => {
    await expect(
      provisionLicense({
        orgName: 'Test Org',
        planName: undefined,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow(/Unknown plan/);
  });

  it('should throw a clear error when planName is null', async () => {
    await expect(
      provisionLicense({
        orgName: 'Test Org',
        planName: null,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow(/Unknown plan/);
  });

  it('should correctly compute annual billing with 20% discount', async () => {
    const result = await provisionLicense({
      orgName: 'Annual Org',
      planName: 'starter',
      seats: 5,
      billingCycle: 'annual',
    });

    expect(result.success).toBe(true);
    expect(result.pricePerSeat).toBe(10);
    expect(result.monthlyCost).toBe(50); // 5 seats * $10/seat
    // Annual = monthly * 12 * 0.8 = 50 * 12 * 0.8 = 480
    expect(result.billingAmount).toBe(480);
    expect(result.billingCycle).toBe('annual');
  });

  it('should return correct fields for all valid plan names', async () => {
    for (const planName of Object.keys(PLAN_CONFIGS)) {
      const result = await provisionLicense({
        orgName: 'Test Org',
        planName,
        seats: 1,
        billingCycle: 'monthly',
      });

      expect(result.success).toBe(true);
      expect(result.pricePerSeat).toBe(PLAN_CONFIGS[planName].pricePerSeat);
      expect(result.features).toEqual(PLAN_CONFIGS[planName].features);
      expect(result.supportLevel).toBe(PLAN_CONFIGS[planName].supportLevel);
    }
  });
});
