const { processQuoteRequest, PRODUCTS, ADDONS } = require('../app/services/verticals/382b34fc');

describe('Insurance quote service (382b34fc)', () => {
  test('quotes the auto product, which has no promotional bundle', async () => {
    const result = await processQuoteRequest({ product: 'auto', drivers: 1, addons: [] });

    expect(result.product).toBe('AUTO');
    expect(result.discountPct === undefined || result.discountPct === 0).toBe(true);
    expect(result.promoLabel).toBeNull();
    expect(result.basePremium).toBe(PRODUCTS.auto.basePremium);
    expect(result.totalSavings).toBe(0);
    expect(result.monthlyTotal).toBe(PRODUCTS.auto.basePremium);
  });

  test('applies only add-on savings when the product has no promo', async () => {
    const result = await processQuoteRequest({
      product: 'auto',
      drivers: 2,
      addons: ['roadside', 'rental'],
    });

    const addonSaves = ADDONS.filter((a) => ['roadside', 'rental'].includes(a.id))
      .reduce((sum, a) => sum + a.saves, 0);
    expect(result.totalSavings).toBe(addonSaves);
  });

  test('falls back to auto for an unknown product id without throwing', async () => {
    const result = await processQuoteRequest({ product: 'does-not-exist', drivers: 1, addons: [] });

    expect(result.product).toBe('AUTO');
  });

  test('still applies the promotional discount for products that have one', async () => {
    const result = await processQuoteRequest({ product: 'homeowners', drivers: 1, addons: [] });

    const expectedPromoSavings =
      (PRODUCTS.homeowners.basePremium * PRODUCTS.homeowners.promo.discountPct) / 100;
    expect(result.promoLabel).toBe(PRODUCTS.homeowners.promo.label);
    expect(result.totalSavings).toBeCloseTo(expectedPromoSavings, 2);
    expect(result.monthlyTotal).toBeCloseTo(
      PRODUCTS.homeowners.basePremium - expectedPromoSavings,
      2,
    );
  });
});
