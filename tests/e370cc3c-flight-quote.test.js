/* global describe, expect, test */

const {
  processFlightQuote,
  buildFlightQuote,
  summarizeQuote,
  computeFareBreakdown,
  resolveRoute,
  FARE_PRODUCTS,
} = require('../app/services/verticals/e370cc3c');

function quoteFor(fareProduct, passengers = 1) {
  const route = resolveRoute('SFO', 'JFK');
  const product = FARE_PRODUCTS[fareProduct];
  const fares = computeFareBreakdown(route, product, passengers);
  return { route, quote: buildFlightQuote(route, product, fares, passengers) };
}

describe('flight quote summary', () => {
  test('summarizes a non-accrual fare product without throwing', () => {
    const { route, quote } = quoteFor('comfort_plus');
    expect(quote.accrual).toBeUndefined();

    const summary = summarizeQuote(quote, route);

    expect(summary.accrualEligible).toBe(false);
    expect(summary.milesEarned).toBe(0);
    expect(summary.qualifyingDollars).toBe(0);
    expect(summary.totalFare).toBeGreaterThan(0);
  });

  test('reports earned miles for an accrual-eligible fare product', () => {
    const { route, quote } = quoteFor('main_cabin', 2);

    const summary = summarizeQuote(quote, route);

    expect(summary.accrualEligible).toBe(true);
    expect(summary.milesEarned).toBe(route.distanceMiles * FARE_PRODUCTS.main_cabin.accrualRate * 2);
    expect(summary.qualifyingDollars).toBeGreaterThan(0);
  });

  test('tolerates a quote missing its accrual block entirely', () => {
    const { route, quote } = quoteFor('main_cabin');
    delete quote.accrual;

    expect(() => summarizeQuote(quote, route)).not.toThrow();
    expect(summarizeQuote(quote, route).milesEarned).toBe(0);
  });

  test('processes a comfort_plus quote request end to end', async () => {
    const summary = await processFlightQuote({
      origin: 'SFO',
      destination: 'JFK',
      fareProduct: 'comfort_plus',
      passengers: 1,
    });

    expect(summary.confirmationCode).toMatch(/^DL\d{6}$/);
    expect(summary.milesEarned).toBe(0);
    expect(summary.itinerary).toBe('SFO \u2192 JFK');
  });
});
