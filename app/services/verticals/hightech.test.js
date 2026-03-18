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
  it('should provision a license for the enterprise plan', async () => {
    const result = await provisionLicense({
      orgName: 'Test Corp',
      planName: 'enterprise',
      seats: 15,
      billingCycle: 'annual',
    });

    expect(result.success).toBe(true);
    expect(result.licenseId).toBe('test-uuid-1234');
    expect(result.plan).toBe('enterprise');
    expect(result.seats).toBe(15);
    expect(result.monthlyCost).toBeGreaterThan(0);
    expect(result.billingAmount).toBeGreaterThan(0);
    expect(result.pricePerSeat).toBe(6);
    expect(result.features).toEqual(['basic', 'analytics', 'sso', 'audit']);
    expect(result.supportLevel).toBe('priority');
  });

  it('should provision a license for the starter plan with monthly billing', async () => {
    const result = await provisionLicense({
      orgName: 'Small Startup',
      planName: 'starter',
      seats: 3,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('starter');
    expect(result.monthlyCost).toBe(30); // 3 seats * $10/seat
    expect(result.billingAmount).toBe(30); // monthly = monthlyCost
  });

  it('should apply annual discount for annual billing cycle', async () => {
    const result = await provisionLicense({
      orgName: 'Annual Corp',
      planName: 'professional',
      seats: 10,
      billingCycle: 'annual',
    });

    expect(result.success).toBe(true);
    expect(result.monthlyCost).toBe(80); // 10 seats * $8/seat
    expect(result.billingAmount).toBe(768); // 80 * 12 * 0.8
  });

  it('should throw a clear error for an unknown plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Plan Corp',
        planName: 'nonexistent',
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow('Unknown plan: nonexistent');
  });

  it('should throw for case-mismatched plan name (e.g. Professional vs professional)', async () => {
    await expect(
      provisionLicense({
        orgName: 'Case Mismatch Corp',
        planName: 'Professional',
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow('Unknown plan: Professional');
  });

  it('should throw for undefined plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'No Plan Corp',
        planName: undefined,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow('Unknown plan: undefined');
  });

  it('should throw for null plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Null Plan Corp',
        planName: null,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow('Unknown plan: null');
  });

  it('should handle all valid plan names from PLAN_CONFIGS', async () => {
    for (const planName of Object.keys(PLAN_CONFIGS)) {
      const result = await provisionLicense({
        orgName: `Test ${planName}`,
        planName,
        seats: 2,
        billingCycle: 'monthly',
      });
      expect(result.success).toBe(true);
      expect(result.plan).toBe(planName);
    }
  });
});
