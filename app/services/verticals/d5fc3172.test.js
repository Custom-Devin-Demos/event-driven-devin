jest.mock('uuid', () => ({
  v4: jest.fn().mockReturnValue('test-uuid-1234'),
}));

const { processInquiry, PLAN_TIERS, ADDON_CATALOG } = require('./d5fc3172');

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

describe('processInquiry', () => {
  it('succeeds with default business plan and returns certificationLevel', async () => {
    const result = await processInquiry({
      plan: 'business',
      addons: ['ai-companion', 'zoom-phone', 'zoom-rooms'],
      seats: 200,
      region: 'na',
    });

    expect(result).toBeDefined();
    expect(result.complianceStatus).toBe('soc2-type1');
    expect(result.deployment.governance).toBeDefined();
    expect(result.deployment.governance.certificationLevel).toBe('soc2-type1');
    expect(result.inquiryId).toBeDefined();
    expect(result.licensing).toBeDefined();
    expect(result.licensing.plan).toBe('Business');
  });

  it('returns soc2-type2 certificationLevel for enterprise plan', async () => {
    const result = await processInquiry({
      plan: 'enterprise',
      addons: ['ai-companion'],
      seats: 500,
      region: 'na',
    });

    expect(result.complianceStatus).toBe('soc2-type2');
    expect(result.deployment.governance.certificationLevel).toBe('soc2-type2');
    expect(result.deployment.governance.auditLogging).toBe(true);
  });

  it('returns basic certificationLevel for pro plan', async () => {
    const result = await processInquiry({
      plan: 'pro',
      addons: ['zoom-phone'],
      seats: 10,
      region: 'emea',
    });

    expect(result.complianceStatus).toBe('basic');
    expect(result.deployment.governance.certificationLevel).toBe('basic');
    expect(result.deployment.governance.auditLogging).toBe(false);
  });

  it('returns basic certificationLevel for basic plan', async () => {
    const result = await processInquiry({
      plan: 'basic',
      addons: [],
      seats: 1,
      region: 'apac',
    });

    expect(result.complianceStatus).toBe('basic');
    expect(result.deployment.governance.certificationLevel).toBe('basic');
  });

  it('handles all regions correctly', async () => {
    for (const region of ['na', 'emea', 'apac', 'latam']) {
      const result = await processInquiry({
        plan: 'business',
        addons: ['ai-companion'],
        seats: 100,
        region,
      });

      expect(result.region).toBeDefined();
      expect(result.deployment.governance).toBeDefined();
      expect(result.deployment.governance.certificationLevel).toBe('soc2-type1');
    }
  });

  it('includes governance with dataResidency and auditLogging', async () => {
    const result = await processInquiry({
      plan: 'business',
      addons: ['ai-companion', 'zoom-phone'],
      seats: 50,
      region: 'na',
    });

    const gov = result.deployment.governance;
    expect(gov.dataResidency).toBe('regional');
    expect(gov.auditLogging).toBe(true);
  });
});
