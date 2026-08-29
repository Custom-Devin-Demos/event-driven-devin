const {
  submitInquiry,
  resolveMarketProfile,
  resolveSegmentRouting,
  buildBrandMix,
  MARKET_PROFILES,
  SEGMENT_ROUTING,
  BRANDS,
} = require('../app/services/verticals/2ee77d82');

describe('Restaurant group corporate inquiry service (2ee77d82)', () => {
  test('every market segment has a routing entry', () => {
    Object.values(MARKET_PROFILES).forEach((profile) => {
      expect(SEGMENT_ROUTING[profile.segment]).toBeDefined();
    });
  });

  test('resolves routing for the US market (franchise_global)', () => {
    const profile = resolveMarketProfile('US');
    const routing = resolveSegmentRouting(profile);

    expect(profile.segment).toBe('franchise_global');
    expect(routing).toBeDefined();
    expect(Array.isArray(routing.brands)).toBe(true);
    expect(routing.brands.length).toBeGreaterThan(0);
  });

  test('falls back to global routing for an unknown segment', () => {
    const routing = resolveSegmentRouting({ segment: 'not_a_segment' });

    expect(routing).toBe(SEGMENT_ROUTING.franchise_global);
  });

  test('builds a brand mix of known brands for every routing entry', () => {
    Object.values(SEGMENT_ROUTING).forEach((routing) => {
      const mix = buildBrandMix(routing);

      expect(mix).toHaveLength(routing.brands.length);
      mix.forEach((brand) => {
        expect(BRANDS[brand.code]).toBeDefined();
        expect(typeof brand.name).toBe('string');
        expect(typeof brand.restaurants).toBe('number');
      });
    });
  });

  test('submits a US investor-relations inquiry successfully', async () => {
    const summary = await submitInquiry({ topic: 'investor-relations', market: 'US' });

    expect(summary.success).toBe(true);
    expect(summary.status).toBe('received');
    expect(summary.region).toBe('north-america');
    expect(summary.desk).toBe(SEGMENT_ROUTING.franchise_global.desk);
    expect(summary.brands.map((b) => b.code)).toEqual(SEGMENT_ROUTING.franchise_global.brands);
  });

  test('submits an inquiry with a missing or unknown market by defaulting to US', async () => {
    const summary = await submitInquiry({ topic: 'franchising' });
    const unknown = await submitInquiry({ topic: 'franchising', market: 'ZZ' });

    expect(summary.success).toBe(true);
    expect(unknown.success).toBe(true);
    expect(unknown.desk).toBe(SEGMENT_ROUTING.franchise_global.desk);
  });

  test('submits an international inquiry through the international desk', async () => {
    const summary = await submitInquiry({ topic: 'franchising', market: 'GB' });

    expect(summary.success).toBe(true);
    expect(summary.desk).toBe(SEGMENT_ROUTING.franchise_intl.desk);
    expect(summary.brands.map((b) => b.code)).toEqual(SEGMENT_ROUTING.franchise_intl.brands);
  });
});
