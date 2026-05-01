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
  it('should complete rider signup for us-west with rider plan', async () => {
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

  it('should complete signup for all valid plan and region combinations', async () => {
    for (const plan of PLANS) {
      for (const region of REGIONS) {
        const result = await processSignup({
          plan: plan.id,
          region: region.code,
        });

        expect(result).toBeDefined();
        expect(result.plan).toBe(plan.label);
        expect(result.regionCode).toBe(region.code);
        expect(typeof result.package.capacityRemaining).toBe('number');
        expect(result.package.capacityRemaining).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('should apply promo code when valid referral is provided', async () => {
    const result = await processSignup({
      plan: 'one-basic',
      region: 'us-east',
      referralCode: 'UBER2026',
    });

    expect(result).toBeDefined();
    expect(result.package.promoApplied).toBe('UBER2026');
    expect(result.package.promoDiscount).toContain('20%');
  });

  it('should succeed without promo when referral code is invalid', async () => {
    const result = await processSignup({
      plan: 'rider',
      region: 'us-west',
      referralCode: 'INVALIDCODE',
    });

    expect(result).toBeDefined();
    expect(result.package.promoApplied).toBeUndefined();
  });

  it('should set correct allocation tier based on plan', async () => {
    const standardResult = await processSignup({
      plan: 'rider',
      region: 'us-west',
    });
    expect(standardResult.package.allocationTier).toBe('standard');

    const priorityResult = await processSignup({
      plan: 'one-premium',
      region: 'us-west',
    });
    expect(priorityResult.package.allocationTier).toBe('priority');
  });

  it('should include regionScore as a number', async () => {
    const result = await processSignup({
      plan: 'rider',
      region: 'us-west',
    });

    expect(typeof result.package.regionScore).toBe('number');
  });
});
