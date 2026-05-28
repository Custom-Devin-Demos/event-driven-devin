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

const { processInquiry, LICENSE_TIERS, CLOUD_PRODUCTS } = require('./b3e22436');

describe('b3e22436 — Platform Inquiry', () => {
  describe('processInquiry', () => {
    it('should succeed with default enterprise tier and return certificationLevel', async () => {
      const result = await processInquiry({
        tier: 'enterprise',
        region: 'americas',
        products: ['sales', 'service', 'agentforce'],
        seats: 150,
      });

      expect(result).toBeDefined();
      expect(result.inquiryId).toBeDefined();
      expect(result.complianceCert).toBe('SOC2');
      expect(result.pricing).toBeDefined();
      expect(result.provisioning).toBeDefined();
      expect(result.provisioning.governance).toBeDefined();
      expect(result.provisioning.governance.certificationLevel).toBe('SOC2');
    });

    it('should return correct certificationLevel for each tier', async () => {
      const expected = {
        starter: 'basic',
        professional: 'standard',
        enterprise: 'SOC2',
        unlimited: 'SOC2_ISO27001',
      };

      for (const [tierId, expectedCert] of Object.entries(expected)) {
        const result = await processInquiry({
          tier: tierId,
          region: 'americas',
          products: ['sales'],
          seats: 10,
        });

        expect(result.complianceCert).toBe(expectedCert);
        expect(result.provisioning.governance.certificationLevel).toBe(expectedCert);
      }
    });

    it('should handle all regions without error', async () => {
      const regions = ['americas', 'emea', 'apac', 'japan'];

      for (const region of regions) {
        const result = await processInquiry({
          tier: 'enterprise',
          region,
          products: ['sales', 'service'],
          seats: 50,
        });

        expect(result).toBeDefined();
        expect(result.region).toBe(region.toUpperCase());
        expect(result.complianceCert).toBe('SOC2');
      }
    });

    it('should include governance in provisioning plan', async () => {
      const result = await processInquiry({
        tier: 'professional',
        region: 'emea',
        products: ['sales', 'marketing'],
        seats: 25,
      });

      const plan = result.provisioning;
      expect(plan.governance).toBeDefined();
      expect(plan.governance.certificationLevel).toBe('standard');
      expect(plan.instances).toBeDefined();
      expect(plan.dataAllocation).toBeDefined();
    });

    it('should use default values when data fields are missing', async () => {
      const result = await processInquiry({});

      expect(result).toBeDefined();
      expect(result.complianceCert).toBe('SOC2');
      expect(result.provisioning.governance.certificationLevel).toBe('SOC2');
    });
  });

  describe('exports', () => {
    it('should export LICENSE_TIERS with expected tiers', () => {
      expect(LICENSE_TIERS).toHaveLength(4);
      const ids = LICENSE_TIERS.map((t) => t.id);
      expect(ids).toEqual(['starter', 'professional', 'enterprise', 'unlimited']);
    });

    it('should export CLOUD_PRODUCTS with expected products', () => {
      expect(Object.keys(CLOUD_PRODUCTS)).toEqual(
        expect.arrayContaining(['sales', 'service', 'marketing', 'commerce', 'data', 'agentforce']),
      );
    });
  });
});
