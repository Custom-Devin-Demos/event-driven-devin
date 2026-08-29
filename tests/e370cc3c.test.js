const {
  processFlightQuote,
  ROUTES,
  FARE_PRODUCTS,
} = require('../app/services/verticals/e370cc3c');

describe('Flight quote service (e370cc3c)', () => {
  test('quotes a comfort_plus fare without mileage accrual', async () => {
    const result = await processFlightQuote({
      origin: 'SFO',
      destination: 'JFK',
      fareProduct: 'comfort_plus',
      passengers: 2,
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
      passengers: 1,
    });

    expect(result.accrualEligible).toBe(true);
    expect(result.milesEarned).toBe(
      Math.round(ROUTES[1].distanceMiles * FARE_PRODUCTS.main_cabin.accrualRate),
    );
    expect(result.qualifyingDollars).toBeGreaterThan(0);
  });

  test('falls back to comfort_plus for an unknown fare product', async () => {
    const result = await processFlightQuote({
      origin: 'SFO',
      destination: 'JFK',
      fareProduct: 'does-not-exist',
    });

    expect(result.accrualEligible).toBe(false);
    expect(result.milesEarned).toBe(0);
    expect(result.passengers).toBe(1);
  });

  test('falls back to the first route for an unknown city pair', async () => {
    const result = await processFlightQuote({
      origin: 'XXX',
      destination: 'YYY',
      fareProduct: 'main_cabin',
    });

    expect(result.routeId).toBe(ROUTES[0].id);
    expect(result.distanceMiles).toBe(ROUTES[0].distanceMiles);
  });
});
