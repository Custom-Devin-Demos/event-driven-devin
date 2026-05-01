jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { processSignup, REGIONS, PLANS } = require('./99a8ba1a');

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

describe('processSignup', () => {
  it('should succeed for rider plan in us-west region', async () => {
    const result = await processSignup({
      plan: 'rider',
      region: 'us-west',
    });

    expect(result).toBeDefined();
    expect(result.signupId).toBeDefined();
    expect(result.region).toBe('San Francisco Bay Area');
    expect(result.regionCode).toBe('us-west');
    expect(result.plan).toBe('Uber Rider');
    expect(result.package).toBeDefined();
    expect(typeof result.package.capacityRemaining).toBe('number');
  });

  it('should succeed for all plan and region combinations', async () => {
    for (const plan of PLANS) {
      for (const region of REGIONS) {
        const result = await processSignup({
          plan: plan.id,
          region: region.code,
        });

        expect(result).toBeDefined();
        expect(result.signupId).toBeDefined();
        expect(result.plan).toBe(plan.label);
        expect(result.regionCode).toBe(region.code);
        expect(typeof result.package.capacityRemaining).toBe('number');
      }
    }
  });

  it('should apply promo code when valid referral is provided', async () => {
    const result = await processSignup({
      plan: 'rider',
      region: 'us-west',
      referralCode: 'UBER2026',
    });

    expect(result).toBeDefined();
    expect(result.package.promoApplied).toBe('UBER2026');
    expect(result.package.promoDiscount).toContain('20%');
  });

  it('should handle invalid referral codes gracefully', async () => {
    const result = await processSignup({
      plan: 'rider',
      region: 'us-west',
      referralCode: 'INVALID_CODE',
    });

    expect(result).toBeDefined();
    expect(result.package.promoApplied).toBeUndefined();
  });

  it('should include capacity remaining as a number in the package', async () => {
    const result = await processSignup({
      plan: 'rider',
      region: 'us-west',
    });

    expect(result.package.capacityRemaining).toBeDefined();
    expect(typeof result.package.capacityRemaining).toBe('number');
    expect(result.package.capacityRemaining).toBeGreaterThanOrEqual(0);
  });

  it('should set correct allocation tier based on plan priority', async () => {
    const riderResult = await processSignup({
      plan: 'rider',
      region: 'us-west',
    });
    expect(riderResult.package.allocationTier).toBe('standard');

    const premiumResult = await processSignup({
      plan: 'one-premium',
      region: 'us-west',
    });
    expect(premiumResult.package.allocationTier).toBe('priority');
  });
});
