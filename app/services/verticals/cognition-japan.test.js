const { processContactSales, PLAN_TIERS, calculatePlanPricing } = require('./cognition-japan');

// Mock telemetry dependencies to avoid side effects in tests
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

describe('cognition-japan service', () => {
  describe('PLAN_TIERS', () => {
    it('should contain the Enterprise plan tier', () => {
      expect(PLAN_TIERS).toHaveProperty('Enterprise');
      expect(PLAN_TIERS.Enterprise.pricePerSeat).toBeDefined();
      expect(PLAN_TIERS.Enterprise.currency).toBe('JPY');
    });

    it('should contain all expected plan tiers (Starter, Business, Enterprise)', () => {
      expect(Object.keys(PLAN_TIERS)).toEqual(
        expect.arrayContaining(['Starter', 'Business', 'Enterprise'])
      );
    });

    it('should have valid pricePerSeat for each plan', () => {
      for (const [name, plan] of Object.entries(PLAN_TIERS)) {
        expect(typeof plan.pricePerSeat).toBe('number');
        expect(plan.pricePerSeat).toBeGreaterThan(0);
      }
    });
  });

  describe('calculatePlanPricing', () => {
    it('should return pricing for the Enterprise plan (original failure condition)', () => {
      const result = calculatePlanPricing('Enterprise', 100, { multiplier: 1.0 });
      expect(result).toHaveProperty('monthly');
      expect(result).toHaveProperty('annual');
      expect(result).toHaveProperty('currency', 'JPY');
      expect(result.monthly).toBe(100 * PLAN_TIERS.Enterprise.pricePerSeat);
    });

    it('should return pricing for the Starter plan', () => {
      const result = calculatePlanPricing('Starter', 10, { multiplier: 1.0 });
      expect(result.monthly).toBe(10 * PLAN_TIERS.Starter.pricePerSeat);
      expect(result.currency).toBe('JPY');
    });

    it('should return pricing for the Business plan', () => {
      const result = calculatePlanPricing('Business', 50, { multiplier: 1.0 });
      expect(result.monthly).toBe(50 * PLAN_TIERS.Business.pricePerSeat);
    });

    it('should apply region multiplier to pricing', () => {
      const base = calculatePlanPricing('Enterprise', 10, { multiplier: 1.0 });
      const scaled = calculatePlanPricing('Enterprise', 10, { multiplier: 1.5 });
      expect(scaled.monthly).toBe(Math.round(base.monthly * 1.5));
    });

    it('should throw for an unknown plan ID', () => {
      expect(() => calculatePlanPricing('NonExistent', 10, {})).toThrow('不明なプランID: NonExistent');
    });

    it('should throw for null plan ID', () => {
      expect(() => calculatePlanPricing(null, 10, {})).toThrow('不明なプランID: null');
    });

    it('should throw for undefined plan ID', () => {
      expect(() => calculatePlanPricing(undefined, 10, {})).toThrow('不明なプランID: undefined');
    });

    it('should throw for empty string plan ID', () => {
      expect(() => calculatePlanPricing('', 10, {})).toThrow('不明なプランID: ');
    });
  });

  describe('processContactSales', () => {
    it('should successfully process an Enterprise plan inquiry', async () => {
      const result = await processContactSales({
        company: 'テスト株式会社',
        contact: 'テスト太郎',
        email: 'test@example.co.jp',
        planId: 'Enterprise',
        seats: 100,
      });
      expect(result.success).toBe(true);
      expect(result.plan).toBe('Enterprise');
      expect(result.estimate).toBeDefined();
      expect(result.estimate.currency).toBe('JPY');
    });

    it('should fail for an unknown plan ID and throw an error', async () => {
      await expect(
        processContactSales({
          company: 'テスト株式会社',
          contact: 'テスト太郎',
          email: 'test@example.co.jp',
          planId: 'InvalidPlan',
          seats: 10,
        })
      ).rejects.toThrow('不明なプランID: InvalidPlan');
    });
  });
});
