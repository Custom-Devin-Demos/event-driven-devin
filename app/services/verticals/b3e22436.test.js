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
  Sentry: { captureException: jest.fn() },
}));

jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const { processInquiry } = require('./b3e22436');

describe('b3e22436 platform inquiry service', () => {
  describe('processInquiry', () => {
    it('should succeed with default enterprise tier parameters', async () => {
      const result = await processInquiry({
        tier: 'enterprise',
        region: 'americas',
        products: ['sales', 'service', 'agentforce'],
        seats: 150,
      });

      expect(result).toBeDefined();
      expect(result.inquiryId).toBeDefined();
      expect(result.pricing).toBeDefined();
      expect(result.provisioning).toBeDefined();
      expect(result.complianceCert).toBe('SOC2_ISO27001');
    });

    it('should include governance.certificationLevel in the provisioning plan', async () => {
      const result = await processInquiry({
        tier: 'enterprise',
        region: 'americas',
        products: ['sales'],
        seats: 50,
      });

      expect(result.provisioning.governance).toBeDefined();
      expect(result.provisioning.governance.certificationLevel).toBe('SOC2_ISO27001');
      expect(result.complianceCert).toBe('SOC2_ISO27001');
    });

    it('should set correct certification level for each tier', async () => {
      const tiers = [
        { id: 'starter', expected: 'BASIC' },
        { id: 'professional', expected: 'SOC2' },
        { id: 'enterprise', expected: 'SOC2_ISO27001' },
        { id: 'unlimited', expected: 'SOC2_ISO27001_HIPAA' },
      ];

      for (const { id, expected } of tiers) {
        const result = await processInquiry({
          tier: id,
          region: 'americas',
          products: ['sales'],
          seats: 10,
        });

        expect(result.provisioning.governance.certificationLevel).toBe(expected);
        expect(result.complianceCert).toBe(expected);
      }
    });

    it('should set dataResidency based on seat count', async () => {
      const smallResult = await processInquiry({
        tier: 'starter',
        region: 'americas',
        products: ['sales'],
        seats: 50,
      });
      expect(smallResult.provisioning.governance.dataResidency).toBe('shared');

      const largeResult = await processInquiry({
        tier: 'enterprise',
        region: 'americas',
        products: ['sales'],
        seats: 200,
      });
      expect(largeResult.provisioning.governance.dataResidency).toBe('dedicated');
    });

    it('should handle all supported regions', async () => {
      const regions = ['americas', 'emea', 'apac', 'japan'];

      for (const region of regions) {
        const result = await processInquiry({
          tier: 'enterprise',
          region,
          products: ['sales'],
          seats: 50,
        });

        expect(result).toBeDefined();
        expect(result.region).toBe(region.toUpperCase());
        expect(result.provisioning.governance).toBeDefined();
      }
    });
  });
});
