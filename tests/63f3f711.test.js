const {
  submitInquiry,
  PRODUCTS,
  REGION_PROFILES,
  FEE_SCHEDULES,
  resolveRegionProfile,
  resolveVolumeTier,
  buildSettlementLane,
  buildRateQuote,
} = require('../app/services/verticals/63f3f711');

describe('Payments sales inquiry service (63f3f711)', () => {
  test('quotes a domestic US payments inquiry without throwing', async () => {
    const result = await submitInquiry({
      product: 'payments',
      country: 'US',
      estimatedMonthlyUsd: 50000,
    });

    expect(result.success).toBe(true);
    expect(result.quote.lane).toBe('standard-domestic');
    expect(result.quote.listPercentage).toBe(FEE_SCHEDULES['standard-domestic'].percentage);
    expect(result.quote.effectivePercentage).toBe(2.9);
    expect(result.quote.currency).toBe('usd');
  });

  test('applies the volume discount for a cross-border platform product', async () => {
    const result = await submitInquiry({
      product: 'connect',
      country: 'GB',
      estimatedMonthlyUsd: 5000000,
    });

    expect(result.quote.lane).toBe('platform-cross-border');
    expect(result.quote.volumeTier).toBe('scale');
    expect(result.quote.effectivePercentage).toBe(3.12);
    expect(result.quote.currency).toBe('gbp');
  });

  test('every product and region pairing resolves to a published fee schedule', () => {
    Object.values(PRODUCTS).forEach((product) => {
      Object.keys(REGION_PROFILES).forEach((country) => {
        const profile = resolveRegionProfile(country);
        const lane = buildSettlementLane(product, profile);

        expect(FEE_SCHEDULES[lane]).toBeDefined();
        expect(buildRateQuote(product, profile, resolveVolumeTier(50000)).lane).toBe(lane);
      });
    });
  });

  test('unknown countries fall back to the US profile', async () => {
    const result = await submitInquiry({ product: 'payments', country: 'ZZ' });

    expect(result.quote.lane).toBe('standard-domestic');
    expect(result.region).toBe('north-america');
  });

  test('throws a descriptive error when no schedule exists for the lane', () => {
    const product = { code: 'unknown', name: 'Unknown', settlement: 'unknown' };
    const profile = REGION_PROFILES.US;

    expect(() => buildRateQuote(product, profile, resolveVolumeTier(50000))).toThrow(
      /No fee schedule published for settlement lane "unknown-domestic"/,
    );
  });
});
