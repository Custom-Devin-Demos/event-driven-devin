const {
  submitInquiry,
  PRODUCTS,
  REGION_PROFILES,
  FEE_SCHEDULES,
  VOLUME_TIERS,
  resolveRegionProfile,
  buildSettlementLane,
  resolveVolumeTier,
  buildRateQuote,
} = require('../app/services/verticals/63f3f711');

describe('payments sales inquiry service (63f3f711)', () => {
  test('quotes a domestic payments inquiry without throwing', async () => {
    const summary = await submitInquiry({
      product: 'payments',
      country: 'US',
      estimatedMonthlyUsd: 250000,
    });

    expect(summary.success).toBe(true);
    expect(summary.quote.lane).toBe('standard-domestic');
    expect(summary.quote.listPercentage).toBe(FEE_SCHEDULES['standard-domestic'].percentage);
    expect(summary.quote.effectivePercentage).toBe(2.61);
    expect(summary.quote.currency).toBe('usd');
    expect(summary.quote.volumeTier).toBe('growth');
  });

  test('quotes a cross-border platform inquiry', async () => {
    const summary = await submitInquiry({
      product: 'connect',
      country: 'DE',
      estimatedMonthlyUsd: 5000000,
    });

    expect(summary.success).toBe(true);
    expect(summary.quote.lane).toBe('platform-cross-border');
    expect(summary.quote.currency).toBe('eur');
    expect(summary.quote.fixedFee).toBe(FEE_SCHEDULES['platform-cross-border'].fixed);
  });

  test('every product and region pairing maps to a published fee schedule', () => {
    Object.values(PRODUCTS).forEach((product) => {
      Object.keys(REGION_PROFILES).forEach((country) => {
        const profile = resolveRegionProfile(country);
        const lane = buildSettlementLane(product, profile);

        expect(FEE_SCHEDULES[lane]).toBeDefined();
        expect(() => buildRateQuote(product, profile, VOLUME_TIERS[0])).not.toThrow();
      });
    });
  });

  test('unknown country falls back to the US profile and still quotes', () => {
    const profile = resolveRegionProfile('ZZ');
    const quote = buildRateQuote(PRODUCTS.payments, profile, resolveVolumeTier(undefined));

    expect(quote.lane).toBe('standard-domestic');
    expect(quote.effectivePercentage).toBe(FEE_SCHEDULES['standard-domestic'].percentage);
  });

  test('an unmapped settlement lane raises an explicit error, not a TypeError', () => {
    const product = { ...PRODUCTS.payments, settlement: 'unmapped' };

    expect(() => buildRateQuote(product, REGION_PROFILES.US, VOLUME_TIERS[0])).toThrow(
      /No published fee schedule for settlement lane "unmapped-domestic"/,
    );
    expect(() => buildRateQuote(product, REGION_PROFILES.US, VOLUME_TIERS[0])).not.toThrow(
      TypeError,
    );
  });
});
