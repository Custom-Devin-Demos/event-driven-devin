// Mock uuid before importing the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock telemetry and external dependencies
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../../telemetry/datadog', () => ({
  initDatadog: jest.fn(),
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../../telemetry/sentry', () => ({
  initSentry: jest.fn(),
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const { processContactSales, PLAN_TIERS } = require('./cognition-japan');

describe('cognition-japan service', () => {
  describe('PLAN_TIERS', () => {
    it('should contain the Enterprise plan tier', () => {
      expect(PLAN_TIERS).toHaveProperty('Enterprise');
      expect(PLAN_TIERS.Enterprise.nameJa).toBe('エンタープライズ');
      expect(PLAN_TIERS.Enterprise.pricePerSeat).toBe(900);
      expect(PLAN_TIERS.Enterprise.currency).toBe('JPY');
      expect(PLAN_TIERS.Enterprise.features).toContain('sso');
      expect(PLAN_TIERS.Enterprise.features).toContain('dedicated-csm');
    });

    it('should contain the Starter plan tier', () => {
      expect(PLAN_TIERS).toHaveProperty('Starter');
      expect(PLAN_TIERS.Starter.pricePerSeat).toBe(1500);
    });

    it('should contain the Business plan tier', () => {
      expect(PLAN_TIERS).toHaveProperty('Business');
      expect(PLAN_TIERS.Business.pricePerSeat).toBe(1200);
    });
  });

  describe('processContactSales', () => {
    it('should succeed with Enterprise plan (the original failure case)', async () => {
      const result = await processContactSales({
        company: '株式会社サンプル',
        contact: '山田太郎',
        email: 'taro@example.co.jp',
        planId: 'Enterprise',
        seats: 100,
      });

      expect(result.success).toBe(true);
      expect(result.plan).toBe('Enterprise');
      expect(result.planNameJa).toBe('エンタープライズ');
      expect(result.estimate.currency).toBe('JPY');
      expect(result.estimate.monthly).toBe(90000); // 900 * 100
      expect(result.estimate.annual).toBe(918000); // 900 * 100 * 12 * 0.85
    });

    it('should succeed with Starter plan', async () => {
      const result = await processContactSales({
        company: 'テスト株式会社',
        contact: '佐藤次郎',
        email: 'jiro@example.co.jp',
        planId: 'Starter',
        seats: 5,
      });

      expect(result.success).toBe(true);
      expect(result.plan).toBe('Starter');
      expect(result.planNameJa).toBe('スターター');
    });

    it('should succeed with Business plan', async () => {
      const result = await processContactSales({
        company: 'ビジネス株式会社',
        contact: '田中花子',
        email: 'hanako@example.co.jp',
        planId: 'Business',
        seats: 25,
      });

      expect(result.success).toBe(true);
      expect(result.plan).toBe('Business');
      expect(result.planNameJa).toBe('ビジネス');
    });

    it('should throw for an unknown plan ID', async () => {
      await expect(processContactSales({
        company: '不明株式会社',
        contact: '不明太郎',
        email: 'unknown@example.co.jp',
        planId: 'NonExistentPlan',
        seats: 10,
      })).rejects.toThrow('不明なプランID: NonExistentPlan');
    });

    it('should throw for null plan ID', async () => {
      await expect(processContactSales({
        company: '不明株式会社',
        contact: '不明太郎',
        email: 'unknown@example.co.jp',
        planId: null,
        seats: 10,
      })).rejects.toThrow('不明なプランID: null');
    });

    it('should throw for undefined plan ID', async () => {
      await expect(processContactSales({
        company: '不明株式会社',
        contact: '不明太郎',
        email: 'unknown@example.co.jp',
        planId: undefined,
        seats: 10,
      })).rejects.toThrow('不明なプランID: undefined');
    });

    it('should return correct estimate fields', async () => {
      const result = await processContactSales({
        company: 'テスト',
        contact: 'テスト',
        email: 'test@example.co.jp',
        planId: 'Enterprise',
        seats: 200,
      });

      expect(result.estimate).toEqual({
        monthly: 180000,   // 900 * 200
        annual: 1836000,   // 900 * 200 * 12 * 0.85
        currency: 'JPY',
        discount: '15%',
      });
      expect(result.features).toEqual(expect.arrayContaining(['sso', 'audit-log']));
      expect(result.slaHours).toBe(4);
    });
  });
});
