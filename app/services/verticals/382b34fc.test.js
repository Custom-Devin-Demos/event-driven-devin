const { processQuoteRequest, PRODUCTS } = require('./382b34fc');

describe('insurance quote — buildSavingsSummary promo handling', () => {
  // Regression: the `auto` product has no `promo`, which previously caused
  // "TypeError: Cannot read properties of undefined (reading 'discountPct')"
  // in buildSavingsSummary (NODE-EXPRESS-2P).
  it('returns a quote for the auto product (no promo) without throwing', async () => {
    expect(PRODUCTS.auto.promo).toBeUndefined();

    const quote = await processQuoteRequest({ product: 'auto', drivers: 1, addons: [] });

    expect(quote.product).toBe('AUTO');
    expect(quote.promoLabel).toBeNull();
    expect(quote.totalSavings).toBe(0);
    expect(typeof quote.monthlyTotal).toBe('number');
  });

  it('defaults an unknown product to auto and still quotes successfully', async () => {
    const quote = await processQuoteRequest({ product: 'does-not-exist', drivers: 1, addons: [] });

    expect(quote.product).toBe('AUTO');
    expect(quote.promoLabel).toBeNull();
    expect(quote.totalSavings).toBe(0);
  });

  it('applies the promo discount for a product that has a promo', async () => {
    expect(PRODUCTS.homeowners.promo).toBeDefined();

    const quote = await processQuoteRequest({ product: 'homeowners', drivers: 1, addons: [] });

    expect(quote.product).toBe('HOME');
    expect(quote.promoLabel).toBe('Bundle & Save');
    // 140 base premium * 15% = 21 promo savings
    expect(quote.totalSavings).toBeGreaterThan(0);
  });

  it('still includes addon savings for the auto (no-promo) product', async () => {
    const quote = await processQuoteRequest({ product: 'auto', drivers: 1, addons: ['roadside'] });

    expect(quote.promoLabel).toBeNull();
    // roadside addon saves 3, with zero promo savings
    expect(quote.totalSavings).toBe(3);
  });
});
