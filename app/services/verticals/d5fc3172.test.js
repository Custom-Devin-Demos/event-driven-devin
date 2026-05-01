/* global jest, describe, it, expect */
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234-5678-9012',
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
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const { processInquiry, PLAN_TIERS, ADDON_CATALOG } = require('./d5fc3172');

describe('d5fc3172 workspace inquiry', () => {
  describe('processInquiry', () => {
    it('should successfully process a business plan inquiry', async () => {
      const result = await processInquiry({
        plan: 'business',
        region: 'na',
        seats: 50,
      });

      expect(result.inquiryId).toBe('test-uuid-1234-5678-9012');
      expect(result.licensing).toBeDefined();
      expect(result.deployment).toBeDefined();
      expect(result.complianceStatus).toBe('SOC2-TypeI');
    });

    it('should successfully process all plan types without errors', async () => {
      for (const plan of PLAN_TIERS) {
        const result = await processInquiry({
          plan: plan.id,
          region: 'na',
          seats: 10,
        });

        expect(result.inquiryId).toBe('test-uuid-1234-5678-9012');
        expect(result.licensing).toBeDefined();
        expect(result.complianceStatus).toBeDefined();
      }
    });

    it('should return SOC2-TypeII certification for enterprise plan', async () => {
      const result = await processInquiry({
        plan: 'enterprise',
        region: 'na',
        seats: 100,
      });

      expect(result.complianceStatus).toBe('SOC2-TypeII');
      expect(result.deployment.governance.certificationLevel).toBe('SOC2-TypeII');
    });

    it('should return basic certification for basic and pro plans', async () => {
      const basicResult = await processInquiry({ plan: 'basic', seats: 5 });
      expect(basicResult.complianceStatus).toBe('basic');

      const proResult = await processInquiry({ plan: 'pro', seats: 5 });
      expect(proResult.complianceStatus).toBe('basic');
    });

    it('should apply region pricing correctly', async () => {
      const naResult = await processInquiry({ plan: 'business', region: 'na', seats: 10 });
      const emeaResult = await processInquiry({ plan: 'business', region: 'emea', seats: 10 });

      expect(naResult.currency).toBe('USD');
      expect(emeaResult.currency).toBe('EUR');
      expect(emeaResult.licensing.pricePerSeat).toBeGreaterThan(naResult.licensing.pricePerSeat);
    });

    it('should default to business plan when plan is not specified', async () => {
      const result = await processInquiry({ seats: 10 });

      expect(result.licensing.plan).toBe('Business');
      expect(result.complianceStatus).toBe('SOC2-TypeI');
    });

    it('should include addons in deployment workspaces', async () => {
      const result = await processInquiry({
        plan: 'business',
        addons: ['zoom-phone', 'zoom-rooms'],
        seats: 20,
      });

      expect(result.deployment.workspaces.length).toBe(2);
      expect(result.deployment.workspaces[0].addon).toBe('Zoom Phone');
      expect(result.deployment.workspaces[1].addon).toBe('Zoom Rooms');
    });

    it('should include governance with certificationLevel in deployment plan', async () => {
      const result = await processInquiry({ plan: 'business', seats: 10 });

      expect(result.deployment.governance).toBeDefined();
      expect(result.deployment.governance.certificationLevel).toBeDefined();
      expect(typeof result.deployment.governance.certificationLevel).toBe('string');
    });
  });
});
