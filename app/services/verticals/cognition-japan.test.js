/* global jest, describe, it, expect */

// Mock uuid before requiring the module (uuid uses ESM exports)
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock dependencies to isolate unit tests
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
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const { processContactSales, PLAN_TIERS } = require('./cognition-japan');

describe('cognition-japan service', () => {
  describe('PLAN_TIERS', () => {
    it('should contain the Enterprise plan tier', () => {
      expect(PLAN_TIERS).toHaveProperty('Enterprise');
      expect(PLAN_TIERS.Enterprise.pricePerSeat).toBe(900);
      expect(PLAN_TIERS.Enterprise.currency).toBe('JPY');
      expect(PLAN_TIERS.Enterprise.nameJa).toBe('エンタープライズ');
    });

    it('should contain the Business plan tier', () => {
      expect(PLAN_TIERS).toHaveProperty('Business');
      expect(PLAN_TIERS.Business.pricePerSeat).toBe(1200);
    });

    it('should contain the Starter plan tier', () => {
      expect(PLAN_TIERS).toHaveProperty('Starter');
      expect(PLAN_TIERS.Starter.pricePerSeat).toBe(1500);
    });
  });

  describe('processContactSales', () => {
    const baseData = {
      company: '株式会社テスト',
      contact: 'テスト太郎',
      email: 'test@example.co.jp',
      seats: 100,
    };

    it('should succeed with Enterprise plan (the original failure condition)', async () => {
      const result = await processContactSales({ ...baseData, planId: 'Enterprise' });
      expect(result.success).toBe(true);
      expect(result.plan).toBe('Enterprise');
      expect(result.planNameJa).toBe('エンタープライズ');
      expect(result.estimate.monthly).toBe(90000); // 100 seats * 900 JPY
      expect(result.estimate.annual).toBe(918000); // 90000 * 12 * 0.85
      expect(result.estimate.currency).toBe('JPY');
      expect(result.status).toBe('received');
      expect(result.message).toContain('お問い合わせありがとうございます');
    });

    it('should succeed with Business plan', async () => {
      const result = await processContactSales({ ...baseData, planId: 'Business' });
      expect(result.success).toBe(true);
      expect(result.plan).toBe('Business');
      expect(result.estimate.monthly).toBe(120000); // 100 seats * 1200 JPY
    });

    it('should succeed with Starter plan', async () => {
      const result = await processContactSales({ ...baseData, planId: 'Starter' });
      expect(result.success).toBe(true);
      expect(result.plan).toBe('Starter');
      expect(result.estimate.monthly).toBe(150000); // 100 seats * 1500 JPY
    });

    it('should throw for an unknown plan ID', async () => {
      await expect(
        processContactSales({ ...baseData, planId: 'InvalidPlan' })
      ).rejects.toThrow('不明なプランID: InvalidPlan');
    });

    it('should throw for undefined plan ID', async () => {
      await expect(
        processContactSales({ ...baseData, planId: undefined })
      ).rejects.toThrow('不明なプランID: undefined');
    });

    it('should throw for null plan ID', async () => {
      await expect(
        processContactSales({ ...baseData, planId: null })
      ).rejects.toThrow('不明なプランID: null');
    });

    it('should throw for lowercase plan ID (case-sensitive lookup)', async () => {
      await expect(
        processContactSales({ ...baseData, planId: 'enterprise' })
      ).rejects.toThrow('不明なプランID: enterprise');
    });
  });
});
