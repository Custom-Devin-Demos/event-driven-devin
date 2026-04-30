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

const { processSignup, REGIONS, PLANS } = require('./99a8ba1a');

describe('rideshare signup (99a8ba1a)', () => {
  describe('processSignup', () => {
    it('should succeed with valid rider plan and us-west region', async () => {
      const result = await processSignup({
        plan: 'rider',
        region: 'us-west',
      });

      expect(result).toBeDefined();
      expect(result.signupId).toBeDefined();
      expect(result.region).toBe('San Francisco Bay Area');
      expect(result.regionCode).toBe('us-west');
      expect(result.plan).toBe('Uber Rider');
      expect(result.package.capacityRemaining).toBeDefined();
      expect(typeof result.package.capacityRemaining).toBe('number');
    });

    it('should succeed with all valid plan types', async () => {
      for (const plan of PLANS) {
        const result = await processSignup({
          plan: plan.id,
          region: 'us-east',
        });
        expect(result.plan).toBe(plan.label);
        expect(result.package.capacityRemaining).toBeDefined();
        expect(typeof result.package.capacityRemaining).toBe('number');
      }
    });

    it('should succeed with all valid regions', async () => {
      for (const region of REGIONS) {
        const result = await processSignup({
          plan: 'rider',
          region: region.code,
        });
        expect(result.region).toBe(region.name);
        expect(result.package.capacityRemaining).toBeGreaterThanOrEqual(0);
      }
    });

    it('should apply a valid referral code', async () => {
      const result = await processSignup({
        plan: 'one-basic',
        region: 'us-west',
        referralCode: 'NEWRIDER',
      });

      expect(result.package.promoApplied).toBe('NEWRIDER');
      expect(result.package.promoDiscount).toContain('50%');
    });

    it('should handle an invalid referral code gracefully', async () => {
      const result = await processSignup({
        plan: 'rider',
        region: 'us-west',
        referralCode: 'INVALIDCODE',
      });

      expect(result).toBeDefined();
      expect(result.package.promoApplied).toBeUndefined();
    });

    it('should return numeric capacityRemaining (not nested under onboarding)', async () => {
      const result = await processSignup({
        plan: 'rider',
        region: 'us-west',
      });

      expect(result.package.capacityRemaining).toBeDefined();
      expect(typeof result.package.capacityRemaining).toBe('number');
      expect(result.package.capacityRemaining).toBeGreaterThanOrEqual(0);
    });
  });
});
