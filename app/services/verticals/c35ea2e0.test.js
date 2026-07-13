jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));
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

  it('does not throw for an equipment line without a promo (regression for NODE-EXPRESS-2N)', () => {
    // `aerial` has no `promo` object — previously threw
    // "Cannot read properties of undefined (reading 'rateReduction')".
    expect(EQUIPMENT.aerial.promo).toBeUndefined();
    expect(() => buildSavingsSummary(EQUIPMENT.aerial, pricing, [])).not.toThrow();
  });

  it('treats a missing promo as zero rate reduction with a standard label', () => {
    const summary = buildSavingsSummary(EQUIPMENT.aerial, pricing, []);
    expect(summary.rateReduction).toBe(0);
    expect(summary.rateSavings).toBe(0);
    expect(summary.promoLabel).toBe('Standard rate');
  });

  it('uses the promo rate reduction when the equipment line has one', () => {
    const summary = buildSavingsSummary(EQUIPMENT.materials, { listPrice: 320000 }, []);
    expect(summary.rateReduction).toBe(EQUIPMENT.materials.promo.rateReduction);
    expect(summary.promoLabel).toBe(EQUIPMENT.materials.promo.label);
    expect(summary.rateSavings).toBeCloseTo(320000 * (1.5 / 100), 2);
  });

  it('includes bundle savings from selected support packages', () => {
    const summary = buildSavingsSummary(EQUIPMENT.aerial, pricing, SUPPORT);
    const expectedBundle = SUPPORT.reduce((sum, s) => sum + s.saves, 0);
    expect(summary.bundleSavings).toBe(expectedBundle);
    expect(summary.totalSavings).toBe(expectedBundle);
  });
});

describe('processQuoteRequest', () => {
  it('returns a valid quote for an aerial equipment request (the failing input)', async () => {
    const quote = await processQuoteRequest({ equipment: 'aerial', term: 48, support: [] });
    expect(quote.equipment).toBe('AERIAL');
    expect(quote.totalSavings).toBe(0);
    expect(typeof quote.total).toBe('number');
    expect(quote.requestId).toBeDefined();
  });

  it('defaults unknown equipment ids to aerial without throwing', async () => {
    const quote = await processQuoteRequest({ equipment: 'does-not-exist', term: 0, support: [] });
    expect(quote.equipment).toBe('AERIAL');
  });

  it('still applies promo savings for a promo-backed equipment line', async () => {
    const quote = await processQuoteRequest({ equipment: 'materials', term: 60, support: [] });
    expect(quote.equipment).toBe('MP');
    expect(quote.totalSavings).toBeGreaterThan(0);
  });
});
