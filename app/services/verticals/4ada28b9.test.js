const {
  processFlightSearch,
  computeFareBreakdown,
  buildItinerary,
  findRoute,
  FARE_CLASSES,
} = require('./4ada28b9');

describe('flight search loyalty handling (NODE-EXPRESS-2F regression)', () => {
  describe('computeFareBreakdown', () => {
    it('includes a loyalty object for economy (no loyalty defined on the fare class)', () => {
      const route = findRoute('EWR', 'LAX');
      const breakdown = computeFareBreakdown(route, 'economy', 1);

      // economy has no `loyalty` block in FARE_CLASSES, so it must fall back to a default
      expect(FARE_CLASSES.economy.loyalty).toBeUndefined();
      expect(breakdown.loyalty).toEqual({ milesMultiplier: 1.0, tierBonus: 0 });
    });

    it('passes through the loyalty config for premium cabins', () => {
      const route = findRoute('EWR', 'LAX');
      expect(computeFareBreakdown(route, 'business', 1).loyalty).toEqual(
        FARE_CLASSES.business.loyalty,
      );
      expect(computeFareBreakdown(route, 'first', 2).loyalty).toEqual(
        FARE_CLASSES.first.loyalty,
      );
    });

    it('defaults loyalty for an unknown cabin', () => {
      const route = findRoute('EWR', 'LAX');
      const breakdown = computeFareBreakdown(route, 'no-such-cabin', 1);
      expect(breakdown.loyalty).toEqual({ milesMultiplier: 1.0, tierBonus: 0 });
    });
  });

  describe('buildItinerary', () => {
    it('does not throw for an economy fare and earns base miles (original failure condition)', () => {
      const route = findRoute('EWR', 'LAX');
      const breakdown = computeFareBreakdown(route, 'economy', 1);

      expect(() => buildItinerary(route, breakdown, 1)).not.toThrow();

      const itinerary = buildItinerary(route, breakdown, 1);
      expect(itinerary.milesEarned).toBe(Math.round(route.duration * 1.0));
      expect(itinerary.tierBonus).toBe(0);
    });

    it('applies the cabin miles multiplier and tier bonus for business', () => {
      const route = findRoute('EWR', 'LAX');
      const breakdown = computeFareBreakdown(route, 'business', 1);
      const itinerary = buildItinerary(route, breakdown, 1);

      expect(itinerary.milesEarned).toBe(
        Math.round(route.duration * FARE_CLASSES.business.loyalty.milesMultiplier),
      );
      expect(itinerary.tierBonus).toBe(FARE_CLASSES.business.loyalty.tierBonus);
    });
  });

  describe('processFlightSearch (end-to-end service path)', () => {
    it('resolves a pricing summary for an economy search without throwing', async () => {
      const summary = await processFlightSearch({
        origin: 'EWR',
        destination: 'LAX',
        cabin: 'economy',
        passengers: 1,
        ancillaries: [],
      });

      expect(summary).toMatchObject({ flight: expect.any(String) });
      expect(typeof summary.milesEarned).toBe('number');
      expect(summary.total).toBeGreaterThan(0);
    });
  });
});
