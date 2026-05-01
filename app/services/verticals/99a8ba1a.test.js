jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));
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
  Sentry: { captureException: jest.fn(), setTag: jest.fn(), setExtra: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn(),
}));

const {
  computeOnboardingPackage,
  checkSignupCapacity,
  processSignup,
} = require('./99a8ba1a');

describe('computeOnboardingPackage', () => {
  it('should return capacityRemaining without accessing a nested onboarding property', () => {
    const result = computeOnboardingPackage('rider', 'us-west', null);

    expect(result).toHaveProperty('capacityRemaining');
    expect(typeof result.capacityRemaining).toBe('number');
    expect(result.capacityRemaining).toBeGreaterThanOrEqual(0);
  });

  it('should compute correct capacity for a known region', () => {
    const result = computeOnboardingPackage('rider', 'us-east', null);

    const expectedRemaining = 8000 - 6230;
    expect(result.capacityRemaining).toBe(expectedRemaining);
  });

  it('should handle all plan types without error', () => {
    const plans = ['rider', 'one-basic', 'one-premium', 'business'];
    for (const plan of plans) {
      const result = computeOnboardingPackage(plan, 'us-west', null);
      expect(result).toHaveProperty('capacityRemaining');
      expect(result).toHaveProperty('plan');
      expect(result).toHaveProperty('allocationTier');
    }
  });

  it('should handle all regions without error', () => {
    const regions = ['us-west', 'us-east', 'eu-west', 'ap-south', 'latam'];
    for (const region of regions) {
      const result = computeOnboardingPackage('rider', region, null);
      expect(result).toHaveProperty('capacityRemaining');
      expect(typeof result.capacityRemaining).toBe('number');
    }
  });

  it('should apply promo details when a promo is provided', () => {
    const promo = { code: 'UBER2026', discountPct: 20, maxRides: 5, expiresInDays: 30 };
    const result = computeOnboardingPackage('rider', 'us-west', promo);

    expect(result.promoApplied).toBe('UBER2026');
    expect(result.promoDiscount).toBe('20% off first 5 rides');
    expect(result.promoExpiry).toBe('30 days');
  });

  it('should set allocationTier to priority for plans with priorityPickup', () => {
    const result = computeOnboardingPackage('one-premium', 'us-west', null);
    expect(result.allocationTier).toBe('priority');
  });

  it('should set allocationTier to standard for plans without priorityPickup', () => {
    const result = computeOnboardingPackage('rider', 'us-west', null);
    expect(result.allocationTier).toBe('standard');
  });
});

describe('checkSignupCapacity', () => {
  it('should return remaining directly (not nested under onboarding)', () => {
    const result = checkSignupCapacity('us-west');
    expect(result).toHaveProperty('remaining');
    expect(result).not.toHaveProperty('onboarding');
    expect(typeof result.remaining).toBe('number');
  });

  it('should return Infinity remaining for unknown regions', () => {
    const result = checkSignupCapacity('unknown-region');
    expect(result.remaining).toBe(Infinity);
    expect(result.allowed).toBe(true);
  });
});

describe('processSignup', () => {
  it('should succeed for a valid rider signup in us-west', async () => {
    const result = await processSignup({
      plan: 'rider',
      region: 'us-west',
      referralCode: null,
    });

    expect(result).toHaveProperty('signupId');
    expect(result).toHaveProperty('plan', 'Uber Rider');
    expect(result).toHaveProperty('regionCode', 'us-west');
    expect(result.package).toHaveProperty('capacityRemaining');
  });

  it('should succeed with a valid referral code', async () => {
    const result = await processSignup({
      plan: 'rider',
      region: 'us-west',
      referralCode: 'UBER2026',
    });

    expect(result).toHaveProperty('signupId');
    expect(result.package.promoApplied).toBe('UBER2026');
  });
});
