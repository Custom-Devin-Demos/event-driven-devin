// Mock uuid before requiring the module under test (ESM compatibility)
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock dependencies to isolate business logic
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

const { analyzePortfolio, PORTFOLIO_DATA } = require('./roper-technologies');

describe('analyzePortfolio', () => {
  it('should succeed for Application Software segment', async () => {
    const result = await analyzePortfolio({
      segment: 'Application Software',
      quarter: 'Q1',
      metricFocus: 'revenue',
    });

    expect(result).toBeDefined();
    expect(result.segment).toBe('Application Software');
    expect(result.quarter).toBe('Q1');
    expect(result.companiesAnalyzed).toBe(5);
    expect(result.rating).toBeDefined();
    expect(result.analysisId).toBeDefined();
  });

  it('should succeed for Network Software segment', async () => {
    const result = await analyzePortfolio({
      segment: 'Network Software',
      quarter: 'Q2',
      metricFocus: 'growth',
    });

    expect(result).toBeDefined();
    expect(result.segment).toBe('Network Software');
    expect(result.companiesAnalyzed).toBe(3);
  });

  it('should succeed for Technology Enabled Products segment', async () => {
    const result = await analyzePortfolio({
      segment: 'Technology Enabled Products',
      quarter: 'Q3',
      metricFocus: 'margin',
    });

    expect(result).toBeDefined();
    expect(result.segment).toBe('Technology Enabled Products');
    expect(result.companiesAnalyzed).toBe(4);
  });

  it('should throw when segment key does not match any portfolio data', async () => {
    await expect(
      analyzePortfolio({
        segment: 'Nonexistent Segment',
        quarter: 'Q1',
        metricFocus: 'revenue',
      }),
    ).rejects.toThrow();
  });

  it('should handle undefined companies gracefully by throwing a descriptive error', async () => {
    // This reproduces the original bug: if PORTFOLIO_DATA lookup returns undefined,
    // the code should not pass undefined to computeQuarterlyMetrics
    const originalData = { ...PORTFOLIO_DATA };

    // Temporarily remove a key to simulate a missing segment
    delete PORTFOLIO_DATA['app-software'];

    await expect(
      analyzePortfolio({
        segment: 'Application Software',
        quarter: 'Q1',
        metricFocus: 'revenue',
      }),
    ).rejects.toThrow();

    // Restore
    PORTFOLIO_DATA['app-software'] = originalData['app-software'];
  });

  it('should apply company filter correctly', async () => {
    const result = await analyzePortfolio({
      segment: 'Application Software',
      quarter: 'Q1',
      metricFocus: 'revenue',
      companyFilter: 'Vertafore',
    });

    expect(result).toBeDefined();
    expect(result.companiesAnalyzed).toBe(1);
  });

  it('should work for all quarters', async () => {
    for (const quarter of ['Q1', 'Q2', 'Q3', 'Q4']) {
      const result = await analyzePortfolio({
        segment: 'Application Software',
        quarter,
        metricFocus: 'revenue',
      });
      expect(result).toBeDefined();
      expect(result.quarter).toBe(quarter);
    }
  });
});
