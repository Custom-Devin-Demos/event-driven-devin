const {
  processSubscription,
  buildIntroOffer,
  computeBilling,
  findPlan,
} = require('./b634a963');

describe('buildIntroOffer', () => {
  // Regression: NODE-EXPRESS-30 — computeBilling omitted `promo`, so
  // buildIntroOffer dereferenced `billing.promo.discountRate` on undefined.
  test('reproduces the original failure input (billing without promo) without throwing', () => {
    const billing = computeBilling(findPlan('all_apps'), 'monthly', 1);
    // computeBilling must now carry the plan promo through.
    expect(billing.promo).toEqual({ discountRate: 0.5, months: 3 });
    expect(() => buildIntroOffer(billing, 1)).not.toThrow();
  });

  test('applies the promo discount for a plan that has one (all_apps)', () => {
    const billing = computeBilling(findPlan('all_apps'), 'monthly', 1);
    const offer = buildIntroOffer(billing, 1);
    // 69.99 * (1 - 0.5) = 34.995, rounded to cents = 34.99
    expect(offer.discountedMonthly).toBeCloseTo(34.99, 2);
    expect(offer.promoMonths).toBe(3);
    expect(offer.totalSavings).toBeGreaterThan(0);
  });

  test('does not throw for a plan with no promo (single_app) and yields a zero discount', () => {
    const billing = computeBilling(findPlan('single_app'), 'monthly', 1);
    expect(billing.promo).toBeUndefined();
    const offer = buildIntroOffer(billing, 1);
    expect(offer.discountedMonthly).toBeCloseTo(billing.monthlyRate, 2);
    expect(offer.promoMonths).toBe(0);
    expect(offer.totalSavings).toBe(0);
  });

  test('does not throw when billing.promo is undefined (direct edge case)', () => {
    const billing = { monthlyRate: 19.99 };
    expect(() => buildIntroOffer(billing, 1)).not.toThrow();
    const offer = buildIntroOffer(billing, 1);
    expect(offer.discountedMonthly).toBeCloseTo(19.99, 2);
    expect(offer.promoMonths).toBe(0);
  });
});

describe('processSubscription (end-to-end)', () => {
  test('completes for the all_apps plan that triggered the alert', async () => {
    const summary = await processSubscription({
      plan: 'all_apps',
      billingCycle: 'monthly',
      seats: 1,
      addons: [],
    });
    expect(summary.planCode).toBe('PRO');
    expect(summary.promoMonths).toBe(3);
    expect(summary.firstCycleTotal).toBeGreaterThan(0);
    expect(summary.requestId).toBeDefined();
  });

  test('completes for a plan without a promo (single_app)', async () => {
    const summary = await processSubscription({
      plan: 'single_app',
      billingCycle: 'monthly',
      seats: 1,
      addons: [],
    });
    expect(summary.planCode).toBe('SINGLE');
    expect(summary.promoMonths).toBe(0);
    expect(summary.firstCycleTotal).toBeGreaterThan(0);
  });
});
