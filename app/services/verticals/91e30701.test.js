jest.mock('uuid', () => ({ v4: () => '00000000-0000-0000-0000-000000000000' }));

const {
  processQuoteRequest,
  buildSavingsSummary,
  computeEditionPricing,
  findEdition,
  EDITIONS,
} = require('./91e30701');

describe('buildSavingsSummary', () => {
  it('handles an edition without a promo (starter) without throwing', () => {
    const edition = findEdition('starter');
    expect(edition.promo).toBeUndefined();

    const pricing = computeEditionPricing(edition, 25);
    const summary = buildSavingsSummary(edition, pricing, []);

    expect(summary.seatDiscount).toBe(0);
    expect(summary.promoSavings).toBe(0);
    expect(summary.promoLabel).toBe('Standard pricing');
    expect(summary.totalSavings).toBe(0);
  });

  it('applies the promotional seat discount for editions that have a promo', () => {
    const edition = findEdition('professional');
    const pricing = computeEditionPricing(edition, 10);
    const summary = buildSavingsSummary(edition, pricing, []);

    expect(summary.seatDiscount).toBe(EDITIONS.professional.promo.seatDiscount);
    expect(summary.promoSavings).toBe(EDITIONS.professional.promo.seatDiscount * 10);
    expect(summary.promoLabel).toBe(EDITIONS.professional.promo.label);
  });

  it('adds bundle savings from selected modules to total savings', () => {
    const edition = findEdition('starter');
    const pricing = computeEditionPricing(edition, 5);
    const modules = [{ saves: 5 }, { saves: 8 }];
    const summary = buildSavingsSummary(edition, pricing, modules);

    expect(summary.bundleSavings).toBe(13);
    expect(summary.totalSavings).toBe(13);
  });
});

describe('processQuoteRequest', () => {
  it('returns a quote for the starter edition (regression for NODE-EXPRESS-2M)', async () => {
    const quote = await processQuoteRequest({ edition: 'starter', seats: 25 });

    expect(quote.edition).toBe('STARTER');
    expect(quote.totalSavings).toBe(0);
    expect(quote.monthlyTotal).toBeGreaterThan(0);
    expect(quote.requestId).toBeDefined();
  });

  it('defaults to the starter edition when none is supplied', async () => {
    const quote = await processQuoteRequest({ seats: 10 });

    expect(quote.edition).toBe('STARTER');
    expect(quote.requestId).toBeDefined();
  });

  it('returns a quote for a promo edition with modules', async () => {
    const quote = await processQuoteRequest({
      edition: 'professional',
      seats: 50,
      modules: ['analytics', 'integration'],
    });

    expect(quote.edition).toBe('PRO');
    expect(quote.totalSavings).toBeGreaterThan(0);
    expect(quote.modules).toHaveLength(2);
  });
});
