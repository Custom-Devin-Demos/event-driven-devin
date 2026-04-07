// Mock uuid before requiring the module under test
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
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

// Require after all mocks are set up
const { analyzePortfolio, PORTFOLIO_DATA } = require('./roper-technologies');

describe('roper-technologies analyzePortfolio', () => {
  it('should succeed for "Application Software" segment (original failure condition)', async () => {
    const result = await analyzePortfolio({
      segment: 'Application Software',
      quarter: 'Q1',
      metricFocus: 'revenue',
    });

    expect(result).toBeDefined();
    expect(result.segment).toBe('Application Software');
    expect(result.quarter).toBe('Q1');
    expect(result.companiesAnalyzed).toBe(PORTFOLIO_DATA['app-software'].length);
    expect(parseFloat(result.totalRevenueMM)).toBeGreaterThan(0);
    expect(result.rating).toBeDefined();
    expect(result.analysisId).toBeDefined();
  });

  it('should succeed for "Network Software" segment', async () => {
    const result = await analyzePortfolio({
      segment: 'Network Software',
      quarter: 'Q2',
      metricFocus: 'growth',
    });

    expect(result).toBeDefined();
    expect(result.segment).toBe('Network Software');
    expect(result.companiesAnalyzed).toBe(PORTFOLIO_DATA['network-software'].length);
  });

  it('should succeed for "Technology Enabled Products" segment', async () => {
    const result = await analyzePortfolio({
      segment: 'Technology Enabled Products',
      quarter: 'Q3',
      metricFocus: 'margin',
    });

    expect(result).toBeDefined();
    expect(result.segment).toBe('Technology Enabled Products');
    expect(result.companiesAnalyzed).toBe(PORTFOLIO_DATA['tech-products'].length);
  });

  it('should throw for an unknown segment with no matching portfolio data', async () => {
    await expect(
      analyzePortfolio({
        segment: 'Nonexistent Segment',
        quarter: 'Q1',
        metricFocus: 'revenue',
      }),
    ).rejects.toThrow();
  });

  it('should handle all four quarters correctly', async () => {
    for (const quarter of ['Q1', 'Q2', 'Q3', 'Q4']) {
      const result = await analyzePortfolio({
        segment: 'Application Software',
        quarter,
        metricFocus: 'revenue',
      });
      expect(result.quarter).toBe(quarter);
      expect(result.companiesAnalyzed).toBeGreaterThan(0);
    }
  });

  it('should filter companies when companyFilter is provided', async () => {
    const result = await analyzePortfolio({
      segment: 'Application Software',
      quarter: 'Q1',
      metricFocus: 'revenue',
      companyFilter: 'Vertafore',
    });

    expect(result.companiesAnalyzed).toBe(1);
  });
});
