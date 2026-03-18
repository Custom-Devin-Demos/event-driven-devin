// Mock uuid before importing the module under test (avoids ESM parse error)
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
  it('should provision a license for a valid enterprise plan', async () => {
    const result = await provisionLicense({
      orgName: 'Test Corp',
      planName: 'enterprise',
      seats: 15,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('enterprise');
    expect(result.seats).toBe(15);
    expect(result.monthlyCost).toBe(90); // 15 seats * $6/seat
    expect(result.billingAmount).toBe(90); // monthly = monthlyCost
    expect(result.licenseId).toBeDefined();
    expect(result.features).toEqual(['basic', 'analytics', 'sso', 'audit']);
    expect(result.supportLevel).toBe('priority');
    expect(result.status).toBe('provisioned');
  });

  it('should provision a license for a valid starter plan', async () => {
    const result = await provisionLicense({
      orgName: 'Small Co',
      planName: 'starter',
      seats: 3,
      billingCycle: 'monthly',
    });

    expect(result.success).toBe(true);
    expect(result.plan).toBe('starter');
    expect(result.seats).toBe(3);
    expect(result.monthlyCost).toBe(30); // 3 seats * $10/seat
    expect(result.billingAmount).toBe(30);
  });

  it('should apply annual billing discount (20% off)', async () => {
    const result = await provisionLicense({
      orgName: 'Annual Corp',
      planName: 'professional',
      seats: 10,
      billingCycle: 'annual',
    });

    expect(result.success).toBe(true);
    expect(result.monthlyCost).toBe(80); // 10 seats * $8/seat
    expect(result.billingAmount).toBe(768); // 80 * 12 * 0.8
    expect(result.billingCycle).toBe('annual');
  });

  it('should throw TypeError for an invalid/unknown plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Bad Corp',
        planName: 'nonexistent',
        seats: 5,
        billingCycle: 'monthly',
      }),
    ).rejects.toThrow(TypeError);

    await expect(
      provisionLicense({
        orgName: 'Bad Corp',
        planName: 'nonexistent',
        seats: 5,
        billingCycle: 'monthly',
      }),
    ).rejects.toThrow(/Unknown plan/);
  });

  it('should throw TypeError for plan name with trailing whitespace (original bug)', async () => {
    // This reproduces the original Sentry bug where the frontend sent
    // "enterprise " (with trailing space) which didn't match PLAN_CONFIGS keys
    await expect(
      provisionLicense({
        orgName: 'Whitespace Corp',
        planName: 'enterprise ',
        seats: 15,
        billingCycle: 'monthly',
      }),
    ).rejects.toThrow(TypeError);
  });

  it('should throw TypeError for case-mismatched plan name', async () => {
    // PLAN_CONFIGS uses lowercase keys; uppercase should not match
    await expect(
      provisionLicense({
        orgName: 'Case Corp',
        planName: 'Enterprise',
        seats: 10,
        billingCycle: 'monthly',
      }),
    ).rejects.toThrow(TypeError);
  });

  it('should throw TypeError for undefined/null plan name', async () => {
    await expect(
      provisionLicense({
        orgName: 'Null Corp',
        planName: undefined,
        seats: 5,
        billingCycle: 'monthly',
      }),
    ).rejects.toThrow(TypeError);
  });

  it('should mark withinLimit correctly for unlimited-seat plans', async () => {
    const result = await provisionLicense({
      orgName: 'Big Corp',
      planName: 'enterprise',
      seats: 1000,
      billingCycle: 'monthly',
    });

    expect(result.withinLimit).toBe(true); // enterprise has seats: -1 (unlimited)
  });

  it('should mark withinLimit false when seats exceed plan limit', async () => {
    const result = await provisionLicense({
      orgName: 'Over Corp',
      planName: 'starter',
      seats: 10, // starter limit is 5
      billingCycle: 'monthly',
    });

    expect(result.withinLimit).toBe(false);
  });
});

describe('PLAN_CONFIGS', () => {
  it('should have all expected plan keys in lowercase', () => {
    expect(Object.keys(PLAN_CONFIGS)).toEqual(
      expect.arrayContaining(['starter', 'professional', 'enterprise', 'unlimited']),
    );
  });

  it('should have pricePerSeat defined for every plan', () => {
    for (const [name, config] of Object.entries(PLAN_CONFIGS)) {
      expect(config.pricePerSeat).toBeDefined();
      expect(typeof config.pricePerSeat).toBe('number');
      expect(config.pricePerSeat).toBeGreaterThan(0);
    }
  });
});
