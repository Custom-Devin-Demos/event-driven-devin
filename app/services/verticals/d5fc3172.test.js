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
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const { processInquiry, WORKSPACE_PLANS } = require('./d5fc3172');

describe('d5fc3172 workspace inquiry', () => {
  describe('processInquiry', () => {
    it('should successfully process a business plan inquiry', async () => {
      const result = await processInquiry({
        workspaceName: 'Test Workspace',
        plan: 'business',
        teamSize: 50,
        region: 'us-east-1',
      });

      expect(result.success).toBe(true);
      expect(result.plan.certificationLevel).toBe('advanced');
      expect(result.capacity.total).toBe(100);
      expect(result.capacity.used).toBe(50);
      expect(result.pricing.monthlyPerUser).toBe(24);
      expect(result.inquiryId).toBeDefined();
    });

    it('should successfully process all plan types without errors', async () => {
      for (const planId of Object.keys(WORKSPACE_PLANS)) {
        const result = await processInquiry({
          workspaceName: `${planId} Workspace`,
          plan: planId,
          teamSize: 10,
          region: 'us-east-1',
        });

        expect(result.success).toBe(true);
        expect(result.plan.certificationLevel).toBeDefined();
        expect(result.plan.features).toBeInstanceOf(Array);
      }
    });

    it('should handle the starter plan with certificationLevel "none"', async () => {
      const result = await processInquiry({
        workspaceName: 'Starter WS',
        plan: 'starter',
        teamSize: 3,
        region: 'us-east-1',
      });

      expect(result.success).toBe(true);
      expect(result.plan.certificationLevel).toBe('none');
      expect(result.certification.complianceScore).toBe(0);
    });

    it('should handle the enterprise plan with unlimited users', async () => {
      const result = await processInquiry({
        workspaceName: 'Enterprise WS',
        plan: 'enterprise',
        teamSize: 500,
        region: 'ap-northeast-1',
      });

      expect(result.success).toBe(true);
      expect(result.plan.certificationLevel).toBe('premium');
      expect(result.capacity.total).toBe(500);
      expect(result.pricing.monthlyPerUser).toBe(54);
    });

    it('should apply region pricing multiplier correctly', async () => {
      const usResult = await processInquiry({
        workspaceName: 'US WS',
        plan: 'business',
        teamSize: 10,
        region: 'us-east-1',
      });

      const euResult = await processInquiry({
        workspaceName: 'EU WS',
        plan: 'business',
        teamSize: 10,
        region: 'eu-west-1',
      });

      expect(euResult.pricing.monthlyPerUser).toBeGreaterThan(usResult.pricing.monthlyPerUser);
    });

    it('should default to business plan when plan is not specified', async () => {
      const result = await processInquiry({
        workspaceName: 'Default WS',
        teamSize: 20,
      });

      expect(result.success).toBe(true);
      expect(result.plan.certificationLevel).toBe('advanced');
    });

    it('should throw for an unknown plan', async () => {
      await expect(
        processInquiry({
          workspaceName: 'Bad WS',
          plan: 'nonexistent',
          teamSize: 10,
        }),
      ).rejects.toThrow('Unknown workspace plan: nonexistent');
    });

    it('should fallback to us-east-1 for unknown region', async () => {
      const result = await processInquiry({
        workspaceName: 'Unknown Region WS',
        plan: 'professional',
        teamSize: 10,
        region: 'mars-1',
      });

      expect(result.success).toBe(true);
      expect(result.region.label).toBe('US East (Virginia)');
    });
  });
});
