const {
  processFlightQuote,
  FARE_PRODUCTS,
  ROUTES,
} = require('../app/services/verticals/e370cc3c');

describe('Flight quote service (e370cc3c)', () => {
  test('returns a quote for the non-accruing comfort_plus fare', async () => {
    const result = await processFlightQuote({
      origin: 'SFO',
      destination: 'JFK',
      fareProduct: 'comfort_plus',
      passengers: 2,
    });

    expect(result.routeId).toBe('RT-SFO-JFK');
    expect(result.itinerary).toBe('SFO \u2192 JFK');
    expect(result.accrualEligible).toBe(false);
    expect(result.milesEarned).toBe(0);
    expect(result.qualifyingDollars).toBe(0);
    expect(result.totalFare).toBeGreaterThan(0);
    expect(result.confirmationCode).toMatch(/^DL\d{6}$/);
  });

  test('reports mileage accrual for the eligible main_cabin fare', async () => {
    const result = await processFlightQuote({
      origin: 'SFO',
      destination: 'ATL',
      fareProduct: 'main_cabin',
      passengers: 1,
    });

    const route = ROUTES.find((r) => r.id === 'RT-SFO-ATL');
    expect(result.accrualEligible).toBe(true);
    expect(result.milesEarned).toBe(
      route.distanceMiles * FARE_PRODUCTS.main_cabin.accrualRate,
    );
    expect(result.qualifyingDollars).toBe(Math.round(result.baseFare));
  });

  test('defaults to comfort_plus for an unknown fare product without throwing', async () => {
    const result = await processFlightQuote({
      origin: 'SFO',
      destination: 'JFK',
      fareProduct: 'does-not-exist',
    });

    expect(result.passengers).toBe(1);
    expect(result.milesEarned).toBe(0);
    expect(result.checkedBags).toBe(FARE_PRODUCTS.comfort_plus.checkedBags);
  });
});
