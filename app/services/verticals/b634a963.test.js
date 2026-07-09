// Mock uuid so the CommonJS require in the module under test resolves in Jest
// (the app ships uuid v13, which is ESM-only) and IDs are deterministic.
jest.mock('uuid', () => ({ v4: () => 'test-request-id' }));

const {
  processSubscription,
  computeBilling,
  buildIntroOffer,
  findPlan,
  PLANS,
} = require('./b634a963');

describe('computeBilling', () => {
  it('carries the plan promo through to the billing breakdown', () => {
    const billing = computeBilling(PLANS.all_apps, 'monthly', 1);
    expect(billing.promo).toEqual(PLANS.all_apps.promo);
  });

  it('leaves promo undefined for plans without an introductory offer', () => {
    const billing = computeBilling(PLANS.photography, 'monthly', 1);
    expect(billing.promo).toBeUndefined();
  });
});

describe('buildIntroOffer', () => {
  // Regression: buildIntroOffer used to read billing.promo.discountRate, but
  // computeBilling never propagated promo, so billing.promo was undefined and
  // the call threw "Cannot read properties of undefined (reading 'discountRate')".
  it('does not throw when the promo is present (the original all_apps failure)', () => {
    const billing = computeBilling(PLANS.all_apps, 'monthly', 1);
    expect(() => buildIntroOffer(billing, 1)).not.toThrow();

    const offer = buildIntroOffer(billing, 1);
    // all_apps: monthly 69.99, promo 50% off for 3 months.
    expect(offer.discountedMonthly).toBe(34.99);
    expect(offer.promoMonths).toBe(3);
    expect(offer.totalSavings).toBe(104.98);
  });

  it('handles plans with no promo without throwing (edge case)', () => {
    const billing = computeBilling(PLANS.single_app, 'monthly', 1);
    expect(() => buildIntroOffer(billing, 1)).not.toThrow();

    const offer = buildIntroOffer(billing, 1);
    expect(offer.discountedMonthly).toBe(billing.monthlyRate);
    expect(offer.promoMonths).toBe(0);
    expect(offer.totalSavings).toBe(0);
  });

  it('does not throw when billing is missing the promo field entirely', () => {
    expect(() => buildIntroOffer({ monthlyRate: 10 }, 1)).not.toThrow();
  });
});

describe('processSubscription (end-to-end business logic)', () => {
  it('completes the all_apps subscription that previously triggered the alert', async () => {
    const summary = await processSubscription({
      plan: 'all_apps',
      billingCycle: 'monthly',
      seats: 1,
      addons: [],
    });

    expect(summary.planCode).toBe('PRO');
    expect(summary.discountedMonthly).toBe(34.99);
    expect(summary.promoMonths).toBe(3);
    expect(summary.requestId).toBe('test-request-id');
  });

  it('completes a subscription for a plan without a promo', async () => {
    const summary = await processSubscription({
      plan: 'photography',
      billingCycle: 'annual',
      seats: 2,
      addons: ['stock'],
    });

    expect(summary.planCode).toBe('PHOTO');
    expect(summary.promoMonths).toBe(0);
    expect(summary.totalSavings).toBe(0);
  });

  it('falls back to single_app for an unknown plan id', () => {
    expect(findPlan('does-not-exist')).toBe(PLANS.single_app);
  });
});
