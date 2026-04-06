// Mock uuid before importing the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { runPortfolioAnalysis, FUND_STRATEGIES, VINTAGE_PERFORMANCE } = require('./alpha-wave-global');

// Mock telemetry dependencies to avoid side effects in tests
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

describe('runPortfolioAnalysis', () => {
  it('should succeed with venture-growth strategy', async () => {
    const result = await runPortfolioAnalysis({
      fundStrategy: 'venture-growth',
      vintageYear: '2024',
      analysisType: 'performance',
    });

    expect(result).toBeDefined();
    expect(result.fund).toBe('Venture & Growth Equity');
    expect(result.irr).toBeGreaterThan(0);
    expect(result.moic).toBeGreaterThan(0);
    expect(result.riskLevel).toBeDefined();
    expect(result.sectorDiversity).toBeGreaterThan(0);
    expect(result.analysisId).toBeDefined();
    expect(result.completedAt).toBeDefined();
  });

  it('should succeed with all valid fund strategies', async () => {
    const strategies = Object.keys(FUND_STRATEGIES);
    for (const strategy of strategies) {
      const result = await runPortfolioAnalysis({
        fundStrategy: strategy,
        vintageYear: '2023',
        analysisType: 'performance',
      });
      expect(result).toBeDefined();
      expect(result.fund).toBe(FUND_STRATEGIES[strategy].label);
      expect(result.irr).toBeGreaterThan(0);
    }
  });

  it('should succeed with all valid vintage years', async () => {
    const vintages = Object.keys(VINTAGE_PERFORMANCE);
    for (const vintage of vintages) {
      const result = await runPortfolioAnalysis({
        fundStrategy: 'venture-growth',
        vintageYear: vintage,
        analysisType: 'performance',
      });
      expect(result).toBeDefined();
      expect(result.moic).toBeGreaterThan(0);
    }
  });

  it('should throw for unknown fund strategy', async () => {
    await expect(
      runPortfolioAnalysis({
        fundStrategy: 'nonexistent-strategy',
        vintageYear: '2023',
        analysisType: 'performance',
      }),
    ).rejects.toThrow('Unknown fund strategy: nonexistent-strategy');
  });

  it('should throw for invalid vintage year', async () => {
    await expect(
      runPortfolioAnalysis({
        fundStrategy: 'venture-growth',
        vintageYear: '1999',
        analysisType: 'performance',
      }),
    ).rejects.toThrow('No performance data for vintage 1999');
  });

  it('should throw for unknown analysis type', async () => {
    await expect(
      runPortfolioAnalysis({
        fundStrategy: 'venture-growth',
        vintageYear: '2023',
        analysisType: 'invalid-type',
      }),
    ).rejects.toThrow('Unknown analysis type: invalid-type');
  });

  it('should include investor context when valid investorId is provided', async () => {
    const result = await runPortfolioAnalysis({
      fundStrategy: 'private-credit',
      vintageYear: '2022',
      analysisType: 'risk',
      investorId: 'INV-100201',
    });

    expect(result.investor).toBeDefined();
    expect(result.investor.name).toBe('Pacific Rim Endowment');
    expect(result.investor.tier).toBe('institutional');
  });

  it('should not include investor context when investorId is missing', async () => {
    const result = await runPortfolioAnalysis({
      fundStrategy: 'multi-strategy',
      vintageYear: '2021',
      analysisType: 'exposure',
    });

    expect(result.investor).toBeUndefined();
  });

  it('should produce recommendations when fund underperforms benchmark', async () => {
    const result = await runPortfolioAnalysis({
      fundStrategy: 'venture-growth',
      vintageYear: '2024',
      analysisType: 'performance',
    });

    expect(result.recommendations).toBeDefined();
    expect(Array.isArray(result.recommendations)).toBe(true);
  });
});
