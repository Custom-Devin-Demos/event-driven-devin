const { processQuoteRequest, PRODUCTS, ADDONS } = require('../app/services/verticals/382b34fc');

describe('Insurance quote service (382b34fc)', () => {
  test('quotes the auto product without throwing', async () => {
    const quote = await processQuoteRequest({ product: 'auto', drivers: 1, addons: [] });

    expect(quote.product).toBe('AUTO');
    expect(quote.basePremium).toBe(PRODUCTS.auto.basePremium);
    expect(quote.promoLabel).toBe('Bundle & Save');
    expect(quote.totalSavings).toBeGreaterThan(0);
    expect(quote.monthlyTotal).toBeLessThan(quote.basePremium);
  });

  test('quotes the auto product with add-ons and multiple drivers', async () => {
    const quote = await processQuoteRequest({
      product: 'auto',
      drivers: 2,
      addons: ADDONS.map((a) => a.id),
    });

    expect(quote.drivers).toBe(2);
    expect(quote.addonsCost).toBe(ADDONS.reduce((sum, a) => sum + a.price, 0));
    expect(quote.totalSavings).toBeGreaterThan(0);
  });

  test('falls back to auto for an unknown product id', async () => {
    const quote = await processQuoteRequest({ product: 'does-not-exist', drivers: 1 });

    expect(quote.product).toBe('AUTO');
  });

  test('quotes with no product or addons supplied', async () => {
    const quote = await processQuoteRequest({});

    expect(quote.product).toBe('AUTO');
    expect(quote.drivers).toBeUndefined();
    expect(quote.addonsCost).toBe(0);
    expect(typeof quote.monthlyTotal).toBe('number');
  });

  test('quotes a product whose promo is missing entirely', async () => {
    const promo = PRODUCTS.boat.promo;
    delete PRODUCTS.boat.promo;

    try {
      const quote = await processQuoteRequest({ product: 'boat', drivers: 1, addons: ['rental'] });

      expect(quote.product).toBe('BOAT');
      expect(quote.promoLabel).toBeNull();
      expect(quote.monthlyTotal).toBe(PRODUCTS.boat.basePremium + 12);
      expect(quote.totalSavings).toBe(4);
    } finally {
      PRODUCTS.boat.promo = promo;
    }
  });

  test('every product carries a promo with a numeric discount and label', () => {
    for (const product of Object.values(PRODUCTS)) {
      expect(product.promo).toBeDefined();
      expect(typeof product.promo.discountPct).toBe('number');
      expect(typeof product.promo.label).toBe('string');
    }
  });
});
