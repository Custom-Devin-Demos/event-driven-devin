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
  it('should provision an enterprise license successfully', async () => {
    const result = await provisionLicense({
      orgName: 'Test Org',
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
    expect(result.withinLimit).toBe(true);
    expect(result.status).toBe('provisioned');
  });

  it('should compute annual billing with 20% discount', async () => {
    const result = await provisionLicense({
      orgName: 'Annual Org',
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

  it('should provision a starter plan with seat limit enforcement', async () => {
    const result = await provisionLicense({
      orgName: 'Small Team',
      planName: 'starter',
      seats: 3,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.pricePerSeat).toBe(10);
    expect(result.monthlyCost).toBe(30);
    expect(result.withinLimit).toBe(true);
  });

  it('should flag when seats exceed plan limit', async () => {
    const result = await provisionLicense({
      orgName: 'Over Limit',
      planName: 'starter',
      seats: 10,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.withinLimit).toBe(false);
  });

  it('should throw an error for an unknown plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Plan',
        planName: 'nonexistent',
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow('Unknown plan: nonexistent');
  });

  it('should throw an error for undefined plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'No Plan',
        planName: undefined,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow('Unknown plan: undefined');
  });

  it('should throw an error for null plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Null Plan',
        planName: null,
        seats: 5,
        billingCycle: 'monthly',
      })
    ).rejects.toThrow('Unknown plan: null');
  });

  it('should provision all valid plan types', async () => {
    for (const planName of Object.keys(PLAN_CONFIGS)) {
      const result = await provisionLicense({
        orgName: `Test ${planName}`,
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
