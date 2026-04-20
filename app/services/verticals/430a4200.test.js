// Mock uuid (ESM package) before requiring the module under test
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

const { runAssessment, NETWORK_REGIONS, INFRA_TIERS } = require('./430a4200');

describe('430a4200 Network Capacity Assessment', () => {
  describe('NETWORK_REGIONS', () => {
    it('should have north-america with performance data', () => {
      const region = NETWORK_REGIONS['north-america'];
      expect(region).toBeDefined();
      expect(region.performance).toBeDefined();
      expect(region.performance.latency).toBe(12);
      expect(region.performance.coverage).toBe(0.97);
      expect(region.performance.uptime).toBe(0.998);
    });

    it('should have latin-america WITHOUT performance data (intentional bug)', () => {
      const region = NETWORK_REGIONS['latin-america'];
      expect(region).toBeDefined();
      expect(region.name).toBe('Latin America');
      expect(region.performance).toBeUndefined();
    });
  });

  describe('INFRA_TIERS', () => {
    it('should define enterprise tier with capacity multiplier', () => {
      expect(INFRA_TIERS.enterprise).toBeDefined();
      expect(INFRA_TIERS.enterprise.capacityMultiplier).toBe(2.5);
    });
  });

  describe('runAssessment', () => {
    it('should succeed for north-america region with valid performance data', async () => {
      const result = await runAssessment({
        region: 'north-america',
        subscriberCount: 2500,
        infraTier: 'enterprise',
        networkType: '5G-SA',
      });

      expect(result).toBeDefined();
      expect(result.region).toBe('North America');
      expect(result.networkType).toBe('5G-SA');
      expect(result.infraTier).toBe('enterprise');
      expect(result.scores).toBeDefined();
      expect(result.scores.overall).toBeGreaterThan(0);
      expect(result.recommendation).toBeDefined();
      expect(result.assessmentId).toBeDefined();
    });

    it('should succeed for europe region', async () => {
      const result = await runAssessment({
        region: 'europe',
        subscriberCount: 1000,
        infraTier: 'standard',
        networkType: '4G-LTE',
      });

      expect(result.region).toBe('Europe');
      expect(result.scores.latency).toBe(85);
      expect(result.scores.coverage).toBe(95);
    });

    it('should throw TypeError for latin-america region missing performance data', async () => {
      await expect(
        runAssessment({
          region: 'latin-america',
          subscriberCount: 2500,
          infraTier: 'enterprise',
          networkType: '5G-SA',
        }),
      ).rejects.toThrow(TypeError);

      await expect(
        runAssessment({
          region: 'latin-america',
          subscriberCount: 2500,
          infraTier: 'enterprise',
          networkType: '5G-SA',
        }),
      ).rejects.toThrow(/missing performance data/);
    });

    it('should throw Error for unknown region', async () => {
      await expect(
        runAssessment({
          region: 'antarctica',
          subscriberCount: 100,
          infraTier: 'basic',
          networkType: '4G-LTE',
        }),
      ).rejects.toThrow('Unknown region: antarctica');
    });

    it('should succeed for asia-pacific region', async () => {
      const result = await runAssessment({
        region: 'asia-pacific',
        subscriberCount: 5000,
        infraTier: 'basic',
        networkType: '5G-NSA',
      });

      expect(result.region).toBe('Asia Pacific');
      expect(result.scores.latency).toBe(82);
      expect(result.scores.coverage).toBe(93);
    });
  });
});
