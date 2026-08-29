const {
  submitInquiry,
  BRANDS,
  MARKET_PROFILES,
  SEGMENT_ROUTING,
  resolveMarketProfile,
  resolveSegmentRouting,
  buildBrandMix,
} = require('../app/services/verticals/2ee77d82');

describe('Restaurant group corporate inquiry service (2ee77d82)', () => {
  test('submits a US inquiry without throwing on the brand mix', async () => {
    const result = await submitInquiry({ topic: 'investor-relations', market: 'US' });

    expect(result.success).toBe(true);
    expect(result.desk).toBe(SEGMENT_ROUTING.franchise_global.desk);
    expect(result.region).toBe('north-america');
    expect(result.brands.map((brand) => brand.code)).toEqual([
      'kfc',
      'tacobell',
      'pizzahut',
      'habit',
    ]);
  });

  test('routes an international market to the international desk', async () => {
    const result = await submitInquiry({ topic: 'franchising', market: 'GB' });

    expect(result.desk).toBe('international-development');
    expect(result.responseSlaHours).toBe(48);
  });

  test('every market segment resolves to a routing entry with brands', () => {
    for (const profile of Object.values(MARKET_PROFILES)) {
      const routing = resolveSegmentRouting(profile);
      expect(Array.isArray(routing.brands)).toBe(true);
      expect(routing.brands.length).toBeGreaterThan(0);
    }
  });

  test('falls back to global franchise routing for unmapped or missing segments', () => {
    expect(resolveSegmentRouting({ segment: 'not-a-segment' })).toBe(
      SEGMENT_ROUTING.franchise_global,
    );
    expect(resolveSegmentRouting({})).toBe(SEGMENT_ROUTING.franchise_global);
    expect(resolveSegmentRouting(undefined)).toBe(SEGMENT_ROUTING.franchise_global);
  });

  test('unknown markets fall back to the US profile', () => {
    expect(resolveMarketProfile('ZZ')).toBe(MARKET_PROFILES.US);
    expect(resolveMarketProfile(undefined)).toBe(MARKET_PROFILES.US);
  });

  test('every routed brand code exists in the brand portfolio', () => {
    for (const routing of Object.values(SEGMENT_ROUTING)) {
      for (const code of routing.brands) {
        expect(BRANDS[code]).toBeDefined();
      }
      expect(buildBrandMix(routing)).toHaveLength(routing.brands.length);
    }
  });
});
