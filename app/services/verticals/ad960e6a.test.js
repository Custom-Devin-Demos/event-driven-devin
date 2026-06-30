const {
  processQuoteRequest,
  buildSavingsSummary,
  findPlan,
  computePlanPricing,
  PLANS,
} = require('./ad960e6a');

describe('buildSavingsSummary', () => {
  // Regression: the `standard` tier has no `promo` object. Before the fix,
  // accessing `plan.promo.monthlyDiscount` threw
  // "TypeError: Cannot read properties of undefined (reading 'monthlyDiscount')".
  it('does not throw for a plan tier without a promo (standard)', () => {
    const plan = findPlan('standard');
    expect(plan.promo).toBeUndefined();

    const pricing = computePlanPricing(plan, 12);
    const summary = buildSavingsSummary(plan, pricing, []);

    expect(summary.promoDiscount).toBe(0);
    expect(summary.promoLabel).toBe('No current promotion');
    expect(summary.bundleSavings).toBe(0);
    expect(summary.effectiveMonthly).toBe(pricing.monthly);
    expect(summary.totalMonthlySavings).toBe(0);
  });

  it('applies the promotional discount for a plan tier with a promo', () => {
    const plan = findPlan('performance');
    expect(plan.promo).toBeDefined();

    const pricing = computePlanPricing(plan, 12);
    const summary = buildSavingsSummary(plan, pricing, []);

    expect(summary.promoDiscount).toBe(plan.promo.monthlyDiscount);
    expect(summary.promoLabel).toBe(plan.promo.label);
    expect(summary.effectiveMonthly).toBe(
      Math.round((pricing.monthly - plan.promo.monthlyDiscount) * 100) / 100,
    );
  });

  it('adds bundle savings from selected solutions on top of the promo', () => {
    const plan = findPlan('gigabit');
    const pricing = computePlanPricing(plan, 12);
    const solutions = [{ saves: 10 }, { saves: 10 }];

    const summary = buildSavingsSummary(plan, pricing, solutions);

    expect(summary.bundleSavings).toBe(20);
    expect(summary.totalMonthlySavings).toBe(plan.promo.monthlyDiscount + 20);
  });
});

describe('processQuoteRequest', () => {
  // End-to-end reproduction of the original failure: a quote for the default
  // `standard` plan used to reject with the TypeError. It must now resolve.
  it('resolves for the standard plan (the input that triggered the bug)', async () => {
    const quote = await processQuoteRequest({ plan: 'standard', term: 12, solutions: [] });

    expect(quote).toBeDefined();
    expect(quote.plan).toBe(PLANS.standard.code);
    expect(typeof quote.monthlyTotal).toBe('number');
    expect(Number.isNaN(quote.monthlyTotal)).toBe(false);
    expect(quote.totalMonthlySavings).toBe(0);
  });

  it('resolves for a promo plan (performance) with solutions', async () => {
    const quote = await processQuoteRequest({
      plan: 'performance',
      term: 12,
      solutions: ['securityedge'],
    });

    expect(quote.plan).toBe(PLANS.performance.code);
    expect(quote.totalMonthlySavings).toBeGreaterThan(0);
  });

  it('falls back to the standard plan for an unknown plan id', async () => {
    const quote = await processQuoteRequest({ plan: 'does-not-exist', term: 12, solutions: [] });

    expect(quote.plan).toBe(PLANS.standard.code);
  });
});
