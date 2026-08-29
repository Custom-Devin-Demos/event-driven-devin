const {
  processFlightQuote,
  FARE_PRODUCTS,
  buildFlightQuote,
  computeFareBreakdown,
  resolveRoute,
  summarizeQuote,
} = require('../app/services/verticals/e370cc3c');

function quoteFor(fareProduct, passengers = 1) {
  const route = resolveRoute('SFO', 'JFK');
  const product = FARE_PRODUCTS[fareProduct] || FARE_PRODUCTS.comfort_plus;
  const fares = computeFareBreakdown(route, product, passengers);
  return summarizeQuote(buildFlightQuote(route, product, fares, passengers), route);
}

describe('flight quote summary', () => {
  it('summarizes a non-accrual fare product without throwing', () => {
    const summary = quoteFor('comfort_plus');
    expect(summary.accrualEligible).toBe(false);
    expect(summary.milesEarned).toBe(0);
    expect(summary.qualifyingDollars).toBe(0);
    expect(summary.totalFare).toBeGreaterThan(0);
  });

  it('summarizes an unknown fare product that falls back to comfort_plus', () => {
    const summary = quoteFor('premium');
    expect(summary.accrualEligible).toBe(false);
    expect(summary.milesEarned).toBe(0);
  });

  it('still reports accrual for eligible fare products', () => {
    const summary = quoteFor('main_cabin', 2);
    expect(summary.accrualEligible).toBe(true);
    expect(summary.milesEarned).toBe(2586 * 5 * 2);
    expect(summary.qualifyingDollars).toBeGreaterThan(0);
  });

  it('handles a quote with no accrual block at all', () => {
    const route = resolveRoute('SFO', 'ATL');
    const product = FARE_PRODUCTS.main_cabin;
    const fares = computeFareBreakdown(route, product, 1);
    const quote = buildFlightQuote(route, product, fares, 1);
    delete quote.accrual;
    expect(() => summarizeQuote(quote, route)).not.toThrow();
    expect(summarizeQuote(quote, route).milesEarned).toBe(0);
  });

  it('processes an end-to-end comfort_plus quote request', async () => {
    const result = await processFlightQuote({
      origin: 'SFO',
      destination: 'JFK',
      fareProduct: 'comfort_plus',
      passengers: 1,
    });
    expect(result.milesEarned).toBe(0);
    expect(result.confirmationCode).toMatch(/^DL\d{6}$/);
  });
});
