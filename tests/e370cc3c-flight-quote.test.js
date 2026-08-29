const {
  processFlightQuote,
  buildFlightQuote,
  summarizeQuote,
  resolveRoute,
  FARE_PRODUCTS,
} = require('../app/services/verticals/e370cc3c');

describe('Flight quote service (e370cc3c)', () => {
  test('quotes a comfort_plus fare, which does not accrue miles', async () => {
    const result = await processFlightQuote({
      origin: 'SFO',
      destination: 'JFK',
      fareProduct: 'comfort_plus',
      passengers: 1,
    });

    expect(result.routeId).toBe('RT-SFO-JFK');
    expect(result.accrualEligible).toBe(false);
    expect(result.milesEarned).toBe(0);
    expect(result.qualifyingDollars).toBe(0);
    expect(result.totalFare).toBeGreaterThan(0);
    expect(result.confirmationCode).toMatch(/^DL\d{6}$/);
  });

  test('quotes a main_cabin fare with mileage accrual', async () => {
    const result = await processFlightQuote({
      origin: 'SFO',
      destination: 'ATL',
      fareProduct: 'main_cabin',
      passengers: 2,
    });

    const route = resolveRoute('SFO', 'ATL');
    expect(result.accrualEligible).toBe(true);
    expect(result.milesEarned).toBe(
      Math.round(route.distanceMiles * FARE_PRODUCTS.main_cabin.accrualRate * 2)
    );
    expect(result.qualifyingDollars).toBe(Math.round(result.baseFare));
  });

  test('summarizes a quote that carries no accrual block', () => {
    const route = resolveRoute('SFO', 'JFK');
    const quote = buildFlightQuote(
      route,
      FARE_PRODUCTS.comfort_plus,
      { baseFare: 100, carrierSurcharge: 6.2, taxesAndFees: 13.1, total: 119.3 },
      1
    );

    expect(quote.accrual).toBeUndefined();
    expect(() => summarizeQuote(quote, route)).not.toThrow();
    expect(summarizeQuote(quote, route)).toMatchObject({
      accrualEligible: false,
      milesEarned: 0,
      qualifyingDollars: 0,
      distanceMiles: route.distanceMiles,
    });
  });
});
