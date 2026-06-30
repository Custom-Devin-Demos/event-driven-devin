jest.mock('uuid', () => ({ v4: () => 'test-uuid' }));

const { buildSavingsSummary, PRODUCTS } = require('./382b34fc');

describe('buildSavingsSummary', () => {
  const pricing = { monthly: 95 };
  const addons = [
    { id: 'roadside', label: 'Emergency Roadside Service', price: 8, saves: 3 },
  ];

  it('does not throw for the "auto" product which has no promo (regression for NODE-EXPRESS-2P)', () => {
    const autoProduct = PRODUCTS.auto;
    expect(autoProduct.promo).toBeUndefined();

    expect(() => buildSavingsSummary(autoProduct, pricing, addons)).not.toThrow();

    const summary = buildSavingsSummary(autoProduct, pricing, addons);
    expect(summary).toEqual({
      promoLabel: null,
      discountPct: 0,
      promoSavings: 0,
      bundleSavings: 3,
      totalSavings: 3,
    });
  });

  it('handles a product with no promo and no addons (edge case)', () => {
    const summary = buildSavingsSummary({ code: 'AUTO' }, { monthly: 95 }, []);
    expect(summary).toEqual({
      promoLabel: null,
      discountPct: 0,
      promoSavings: 0,
      bundleSavings: 0,
      totalSavings: 0,
    });
  });

  it('applies the bundle discount for a product that has a promo', () => {
    const homeowners = PRODUCTS.homeowners;
    expect(homeowners.promo).toBeDefined();

    const summary = buildSavingsSummary(homeowners, { monthly: 140 }, addons);
    expect(summary.discountPct).toBe(15);
    expect(summary.promoLabel).toBe('Bundle & Save');
    expect(summary.promoSavings).toBe(21);
    expect(summary.bundleSavings).toBe(3);
    expect(summary.totalSavings).toBe(24);
  });
});
