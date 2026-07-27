const {
  processCreditReportRequest,
  collectScoreFactors,
  summarizeFactors,
  CREDIT_PROFILES,
  SCORE_BANDS,
} = require('../app/services/verticals/f26260e1');

describe('Credit report service (f26260e1)', () => {
  test('generates a report for the fico-8 model (original failure condition)', async () => {
    const report = await processCreditReportRequest({
      scoreModel: 'fico-8',
      bureau: 'experian',
    });

    expect(report.model).toBe(CREDIT_PROFILES['fico-8'].label);
    expect(Number.isFinite(report.score)).toBe(true);
    expect(report.score).toBeGreaterThanOrEqual(300);
    expect(report.score).toBeLessThanOrEqual(850);
    expect(report.band).not.toBe('Unrated');
    expect(report.utilization).toMatch(/^\d+\.\d%$/);
  });

  test('generates a report for the vantage-4 model', async () => {
    const report = await processCreditReportRequest({
      scoreModel: 'vantage-4',
      bureau: 'experian',
    });

    expect(report.model).toBe(CREDIT_PROFILES['vantage-4'].label);
    expect(Number.isFinite(report.score)).toBe(true);
  });

  test('falls back to fico-8 for an unknown score model', async () => {
    const report = await processCreditReportRequest({ scoreModel: 'does-not-exist' });

    expect(report.model).toBe(CREDIT_PROFILES['fico-8'].label);
  });

  test('collectScoreFactors returns factors keyed by name, each with ratio and weight', () => {
    const factors = collectScoreFactors(CREDIT_PROFILES['fico-8']);

    expect(Array.isArray(factors)).toBe(false);
    for (const key of ['utilization', 'paymentHistory', 'creditAge', 'inquiries', 'creditMix']) {
      expect(typeof factors[key].ratio).toBe('number');
      expect(typeof factors[key].weight).toBe('number');
    }
  });

  test('summarizeFactors produces finite metrics from collected factors', () => {
    const summary = summarizeFactors(collectScoreFactors(CREDIT_PROFILES['fico-8']));

    expect(Number.isFinite(summary.utilizationPct)).toBe(true);
    expect(Number.isFinite(summary.weightedScore)).toBe(true);
    expect(summary.weightedScore).toBeGreaterThan(0);
  });

  test('reports zero utilization when there are no revolving tradelines', () => {
    const factors = collectScoreFactors({
      range: { min: 300, max: 850 },
      tradelines: [{ type: 'installment', balance: 9400, original: 15000, ageMonths: 44 }],
      inquiries: 0,
      derogatoryMarks: 0,
    });

    expect(factors.utilization.ratio).toBe(0);
    expect(Number.isFinite(summarizeFactors(factors).weightedScore)).toBe(true);
  });

  test('reports zero utilization when revolving limits are zero', () => {
    const factors = collectScoreFactors({
      range: { min: 300, max: 850 },
      tradelines: [{ type: 'revolving', balance: 500, limit: 0, ageMonths: 12 }],
      inquiries: 3,
      derogatoryMarks: 1,
    });

    expect(factors.utilization.ratio).toBe(0);
    expect(summarizeFactors(factors).utilizationPct).toBe(0);
  });

  test('score bands cover the bottom of the score range', () => {
    expect(SCORE_BANDS[SCORE_BANDS.length - 1].floor).toBeLessThanOrEqual(300);
  });
});
