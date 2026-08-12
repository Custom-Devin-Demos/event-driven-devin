const {
  processQuoteRequest,
  PRODUCTS,
  ADDONS,
} = require('../app/services/verticals/382b34fc');

describe('Insurance quote service (382b34fc) promotional discounts', () => {
  test('quotes the auto product, which carries no promotion', async () => {
    const quote = await processQuoteRequest({ product: 'auto', drivers: 1, addons: [] });

    expect(quote.product).toBe('AUTO');
    expect(quote.promoLabel).toBeNull();
    expect(quote.totalSavings).toBe(0);
    expect(quote.monthlyTotal).toBe(PRODUCTS.auto.basePremium);
  });

  test('applies the promotional discount for a product that has a promotion', async () => {
    const quote = await processQuoteRequest({ product: 'homeowners', drivers: 1, addons: [] });
    const { basePremium, promo } = PRODUCTS.homeowners;

    expect(quote.product).toBe('HOME');
    expect(quote.promoLabel).toBe(promo.label);
    expect(quote.totalSavings).toBe((basePremium * promo.discountPct) / 100);
    expect(quote.monthlyTotal).toBe(basePremium - quote.totalSavings);
  });

  test('quotes an unknown product id, which falls back to auto', async () => {
    const quote = await processQuoteRequest({ product: 'spaceship', drivers: 2, addons: [] });

    expect(quote.product).toBe('AUTO');
    expect(quote.promoLabel).toBeNull();
    expect(quote.monthlyTotal).toBeGreaterThan(0);
  });

  test('still counts add-on bundle savings for a product without a promotion', async () => {
    const addonIds = ADDONS.map((a) => a.id);
    const quote = await processQuoteRequest({ product: 'auto', drivers: 1, addons: addonIds });
    const expectedSavings = ADDONS.reduce((sum, a) => sum + a.saves, 0);

    expect(quote.addons).toHaveLength(ADDONS.length);
    expect(quote.totalSavings).toBe(expectedSavings);
  });
});
