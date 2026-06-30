jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
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

const {
  processQuoteRequest,
  buildSavingsSummary,
  EQUIPMENT,
  SUPPORT,
} = require('./c35ea2e0');

describe('buildSavingsSummary', () => {
  const pricing = { listPrice: 85000 };

  test('handles equipment without a promo (regression for NODE-EXPRESS-2N)', () => {
    const aerial = EQUIPMENT.aerial;
    expect(aerial.promo).toBeUndefined();

    const summary = buildSavingsSummary(aerial, pricing, []);

    expect(summary.rateReduction).toBe(0);
    expect(summary.rateSavings).toBe(0);
    expect(summary.promoLabel).toBe('No promotion');
    expect(summary.totalSavings).toBe(0);
  });

  test('applies the promotional rate reduction when a promo exists', () => {
    const materials = EQUIPMENT.materials;
    expect(materials.promo).toBeDefined();

    const summary = buildSavingsSummary(materials, { listPrice: 320000 }, []);

    expect(summary.rateReduction).toBe(materials.promo.rateReduction);
    expect(summary.promoLabel).toBe(materials.promo.label);
    expect(summary.rateSavings).toBe(
      Math.round(320000 * (materials.promo.rateReduction / 100) * 100) / 100,
    );
  });

  test('includes bundle savings from selected support packages', () => {
    const summary = buildSavingsSummary(EQUIPMENT.aerial, pricing, SUPPORT);
    const expectedBundle = SUPPORT.reduce((sum, s) => sum + s.saves, 0);
    expect(summary.bundleSavings).toBe(expectedBundle);
    expect(summary.totalSavings).toBe(expectedBundle);
  });
});

describe('processQuoteRequest', () => {
  test('resolves for the aerial line (no promo) instead of throwing', async () => {
    const quote = await processQuoteRequest({ equipment: 'aerial', term: 48, support: [] });

    expect(quote.equipment).toBe('AERIAL');
    expect(quote.totalSavings).toBe(0);
    expect(quote.requestId).toBeDefined();
  });

  test('defaults to the aerial line when equipment is omitted', async () => {
    const quote = await processQuoteRequest({});
    expect(quote.equipment).toBe('AERIAL');
    expect(quote.requestId).toBeDefined();
  });

  test('produces savings for a line that has a promo', async () => {
    const quote = await processQuoteRequest({ equipment: 'materials', term: 60, support: [] });
    expect(quote.equipment).toBe('MP');
    expect(quote.totalSavings).toBeGreaterThan(0);
  });
});
