jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));
jest.mock('../../telemetry/logger', () => ({ info: jest.fn(), error: jest.fn() }));
jest.mock('../../telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../../telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));
jest.mock('../devin-session', () => ({ createSessionAndAlert: jest.fn().mockResolvedValue({}) }));

const { processInquiry, PLAN_TIERS, ADDON_CATALOG } = require('./d5fc3172');

describe('d5fc3172 — platform inquiry', () => {
  describe('processInquiry', () => {
    it('should succeed with default business plan without throwing', async () => {
      const result = await processInquiry({
        plan: 'business',
        region: 'na',
        addons: ['ai-companion', 'zoom-phone'],
        seats: 100,
      });

      expect(result).toBeDefined();
      expect(result.inquiryId).toBe('test-uuid-1234');
      expect(result.licensing).toBeDefined();
      expect(result.deployment).toBeDefined();
      expect(result.complianceStatus).toBeDefined();
      expect(result.readinessScore).toBeGreaterThanOrEqual(0);
      expect(result.readinessScore).toBeLessThanOrEqual(100);
    });

    it('should include governance.certificationLevel in deployment plan', async () => {
      const result = await processInquiry({
        plan: 'business',
        region: 'na',
        addons: ['ai-companion'],
        seats: 50,
      });

      expect(result.deployment.governance).toBeDefined();
      expect(result.deployment.governance.certificationLevel).toBe('SOC2-Type1');
      expect(result.deployment.governance.complianceReviewRequired).toBe(true);
    });

    it('should set correct certificationLevel for enterprise plan', async () => {
      const result = await processInquiry({
        plan: 'enterprise',
        region: 'emea',
        addons: ['ai-companion', 'zoom-rooms'],
        seats: 500,
      });

      expect(result.deployment.governance.certificationLevel).toBe('SOC2-Type2');
      expect(result.deployment.governance.complianceReviewRequired).toBe(true);
    });

    it('should set correct certificationLevel for pro plan', async () => {
      const result = await processInquiry({
        plan: 'pro',
        region: 'apac',
        addons: ['zoom-phone'],
        seats: 10,
      });

      expect(result.deployment.governance.certificationLevel).toBe('ISO-27001');
      expect(result.deployment.governance.complianceReviewRequired).toBe(false);
    });

    it('should set correct certificationLevel for basic plan', async () => {
      const result = await processInquiry({
        plan: 'basic',
        region: 'latam',
        addons: [],
        seats: 1,
      });

      expect(result.deployment.governance.certificationLevel).toBe('Basic');
      expect(result.deployment.governance.complianceReviewRequired).toBe(false);
    });

    it('should handle missing plan gracefully (defaults to business)', async () => {
      const result = await processInquiry({
        region: 'na',
      });

      expect(result.deployment.governance).toBeDefined();
      expect(result.deployment.governance.certificationLevel).toBe('SOC2-Type1');
    });

    it('should compute licensing costs correctly', async () => {
      const result = await processInquiry({
        plan: 'business',
        region: 'na',
        addons: ['ai-companion', 'zoom-phone'],
        seats: 100,
      });

      expect(result.licensing.plan).toBe('Business');
      expect(result.licensing.seatCount).toBe(100);
      expect(result.licensing.currency).toBe('USD');
      expect(result.licensing.annualTotal).toBeGreaterThan(0);
    });

    it('should set complianceStatus from governance certificationLevel', async () => {
      const result = await processInquiry({
        plan: 'enterprise',
        region: 'na',
        addons: ['ai-companion'],
        seats: 500,
      });

      expect(result.complianceStatus).toBe('SOC2-Type2');
      expect(result.complianceStatus).toBe(result.deployment.governance.certificationLevel);
    });
  });
});
