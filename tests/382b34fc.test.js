const {
  processQuoteRequest,
  PRODUCTS,
  ADDONS,
} = require('../app/services/verticals/382b34fc');

describe('Insurance quote service (382b34fc)', () => {
  test('quotes an auto policy, which carries no promotional discount', async () => {
    const quote = await processQuoteRequest({ product: 'auto', drivers: 1 });

    expect(quote.product).toBe('AUTO');
    expect(quote.basePremium).toBe(PRODUCTS.auto.basePremium);
    expect(quote.promoLabel).toBeNull();
    expect(quote.totalSavings).toBe(0);
    expect(quote.monthlyTotal).toBe(PRODUCTS.auto.basePremium);
    expect(quote.requestId).toBeTruthy();
  });

  test('applies the promotional discount for a product that has one', async () => {
    const quote = await processQuoteRequest({ product: 'homeowners', drivers: 1 });
    const expectedPromoSavings =
      (PRODUCTS.homeowners.basePremium * PRODUCTS.homeowners.promo.discountPct) / 100;

    expect(quote.product).toBe('HOME');
    expect(quote.promoLabel).toBe(PRODUCTS.homeowners.promo.label);
    expect(quote.totalSavings).toBe(expectedPromoSavings);
    expect(quote.monthlyTotal).toBe(PRODUCTS.homeowners.basePremium - expectedPromoSavings);
  });

  test('falls back to auto for an unknown product id without throwing', async () => {
    const quote = await processQuoteRequest({ product: 'does-not-exist', drivers: 2 });

    expect(quote.product).toBe('AUTO');
    expect(quote.promoLabel).toBeNull();
    expect(quote.monthlyTotal).toBeGreaterThan(0);
  });

  test('quotes an auto policy with add-ons, counting bundle savings only', async () => {
    const quote = await processQuoteRequest({
      product: 'auto',
      drivers: 1,
      addons: ['roadside', 'rental'],
    });
    const selected = ADDONS.filter((a) => ['roadside', 'rental'].includes(a.id));
    const addonsCost = selected.reduce((sum, a) => sum + a.price, 0);
    const bundleSavings = selected.reduce((sum, a) => sum + a.saves, 0);

    expect(quote.addonsCost).toBe(addonsCost);
    expect(quote.totalSavings).toBe(bundleSavings);
    expect(quote.monthlyTotal).toBe(PRODUCTS.auto.basePremium + addonsCost);
  });

  test('handles a missing product id and missing driver count', async () => {
    const quote = await processQuoteRequest({});

    expect(quote.product).toBe('AUTO');
    expect(quote.drivers).toBeUndefined();
    expect(quote.monthlyTotal).toBe(PRODUCTS.auto.basePremium);
  });
});
