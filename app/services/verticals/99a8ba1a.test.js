jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));
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

const { processSignup } = require('./99a8ba1a');

describe('processSignup', () => {
  it('should complete signup for rider plan without throwing', async () => {
    const result = await processSignup({
      plan: 'rider',
      region: 'us-west',
      referralCode: null,
    });

    expect(result).toBeDefined();
    expect(result.signupId).toBeDefined();
    expect(result.plan).toBe('Uber Rider');
    expect(result.regionCode).toBe('us-west');
    expect(result.package).toBeDefined();
    expect(typeof result.package.capacityRemaining).toBe('number');
  });

  it('should complete signup for all plan types across all regions', async () => {
    const plans = ['rider', 'one-basic', 'one-premium', 'business'];
    const regions = ['us-west', 'us-east', 'eu-west', 'ap-south', 'latam'];

    for (const plan of plans) {
      for (const region of regions) {
        const result = await processSignup({ plan, region, referralCode: null });
        expect(result).toBeDefined();
        expect(result.signupId).toBeDefined();
        expect(typeof result.package.capacityRemaining).toBe('number');
      }
    }
  });

  it('should apply promo code correctly', async () => {
    const result = await processSignup({
      plan: 'one-basic',
      region: 'us-east',
      referralCode: 'UBER2026',
    });

    expect(result).toBeDefined();
    expect(result.package.promoApplied).toBe('UBER2026');
    expect(result.package.promoDiscount).toContain('20%');
  });

  it('should handle unknown promo code gracefully', async () => {
    const result = await processSignup({
      plan: 'rider',
      region: 'us-west',
      referralCode: 'INVALID_CODE',
    });

    expect(result).toBeDefined();
    expect(result.package.promoApplied).toBeUndefined();
  });

  it('should include capacityRemaining as a number in the response package', async () => {
    const result = await processSignup({
      plan: 'rider',
      region: 'us-west',
      referralCode: null,
    });

    expect(result.package).toHaveProperty('capacityRemaining');
    expect(typeof result.package.capacityRemaining).toBe('number');
    expect(result.package.capacityRemaining).toBeGreaterThanOrEqual(0);
  });
});
