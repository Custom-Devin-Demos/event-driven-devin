const { processQuoteRequest, PRODUCTS, ADDONS } = require('../app/services/verticals/382b34fc');

describe('Insurance quote service (382b34fc)', () => {
  test('quotes the auto product, which has no active promotion', async () => {
    const result = await processQuoteRequest({ product: 'auto', drivers: 1, addons: [] });

    expect(result.product).toBe('AUTO');
    expect(result.basePremium).toBe(PRODUCTS.auto.basePremium);
    expect(result.promoLabel).toBeNull();
    expect(result.totalSavings).toBe(0);
    expect(result.monthlyTotal).toBe(PRODUCTS.auto.basePremium);
    expect(result.requestId).toBeDefined();
  });

  test('applies the promotional discount for a product with a promo', async () => {
    const result = await processQuoteRequest({ product: 'homeowners', drivers: 1, addons: [] });
    const expectedPromoSavings = (PRODUCTS.homeowners.basePremium * PRODUCTS.homeowners.promo.discountPct) / 100;

    expect(result.product).toBe('HOME');
    expect(result.promoLabel).toBe(PRODUCTS.homeowners.promo.label);
    expect(result.totalSavings).toBe(Math.round(expectedPromoSavings * 100) / 100);
  });

  test('keeps add-on bundle savings for a product without a promo', async () => {
    const result = await processQuoteRequest({ product: 'auto', drivers: 2, addons: ['roadside', 'rental'] });
    const roadside = ADDONS.find((a) => a.id === 'roadside');
    const rental = ADDONS.find((a) => a.id === 'rental');

    expect(result.addonsCost).toBe(roadside.price + rental.price);
    expect(result.totalSavings).toBe(roadside.saves + rental.saves);
    expect(result.drivers).toBe(2);
  });

  test('falls back to the auto product for an unknown product id', async () => {
    const result = await processQuoteRequest({ product: 'does-not-exist', drivers: 1, addons: [] });

    expect(result.product).toBe('AUTO');
    expect(result.discountPct).toBeUndefined();
    expect(result.monthlyTotal).toBe(PRODUCTS.auto.basePremium);
  });

  test('ignores unknown add-on ids', async () => {
    const result = await processQuoteRequest({ product: 'renters', drivers: 1, addons: ['nope'] });

    expect(result.addons).toEqual([]);
    expect(result.addonsCost).toBe(0);
  });
});
