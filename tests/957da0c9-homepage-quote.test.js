/* global describe, expect, test, jest, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { startQuote, buildQuote } = require('../app/services/verticals/957da0c9');
const { PRODUCT_CATALOG, INTENT_TO_PRODUCT } = require('../app/services/verticals/957da0c9-products');
const { RATE_TABLES, monthlyPremium } = require('../app/services/verticals/957da0c9-rates');

beforeEach(() => {
  jest.clearAllMocks();
});

describe('957da0c9 homepage quote engine', () => {
  test('every catalog ratingBasis has a rate table', () => {
    PRODUCT_CATALOG.forEach((product) => {
      expect(RATE_TABLES[product.ratingBasis]).toBeDefined();
      expect(Array.isArray(RATE_TABLES[product.ratingBasis].bands)).toBe(true);
    });
  });

  test.each(PRODUCT_CATALOG.map((p) => [p.code, p]))('prices a quote for %s', async (code, product) => {
    const quote = await startQuote({ selection: code, entryPoint: 'test', report: false });

    expect(quote.product).toBe(product.code);
    expect(quote.productName).toBe(product.name);
    expect(quote.termYears).toBe(product.defaultTerm);
    expect(Number.isFinite(quote.monthlyPremium)).toBe(true);
    expect(quote.monthlyPremium).toBeGreaterThan(0);
    expect(quote.annualPremium).toBeCloseTo(quote.monthlyPremium * 12, 2);
    expect(quote.coverage).toBeGreaterThanOrEqual(RATE_TABLES[product.ratingBasis].minCoverage);
    expect(quote.quoteId).toMatch(/^GQ-[0-9A-F]{8}$/);
  });

  test('reproduces the alert: LIFE via "I am an individual or family" succeeds without reporting', async () => {
    const quote = await startQuote({
      selection: 'individual',
      entryPoint: 'iam:an individual or family',
      applicant: { age: 38, coverage: 500000, tobacco: false },
    });

    expect(quote.product).toBe('LIFE');
    expect(quote.monthlyPremium).toBe(42);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('every homepage intent resolves to a priceable product', async () => {
    const intents = [...Object.keys(INTENT_TO_PRODUCT), '', 'unknown-tile', undefined];
    await Promise.all(intents.map(async (selection) => {
      const quote = await startQuote({ selection, report: false });
      expect(quote.monthlyPremium).toBeGreaterThan(0);
    }));
  });

  test('missing or invalid applicant falls back to defaults', async () => {
    const quotes = await Promise.all([
      startQuote({ selection: 'LIFE', report: false }),
      startQuote({ selection: 'LIFE', applicant: null, report: false }),
      startQuote({ selection: 'LIFE', applicant: { age: 'abc', coverage: -5 }, report: false }),
    ]);
    quotes.forEach((q) => {
      expect(q.monthlyPremium).toBe(42);
      expect(q.coverage).toBe(500000);
    });
  });

  test('coverage below the table minimum is raised to the minimum', () => {
    const life = PRODUCT_CATALOG.find((p) => p.code === 'LIFE');
    const quote = buildQuote(life, { age: 25, coverage: 1000, tobacco: false });
    expect(quote.coverage).toBe(RATE_TABLES['term-life'].minCoverage);
    expect(quote.monthlyPremium).toBe(7.1);
  });

  test('tobacco load and out-of-range ages are applied', () => {
    const table = RATE_TABLES['term-life'];
    expect(monthlyPremium(table, { age: 38, coverage: 500000, tobacco: true })).toBe(98.7);
    expect(monthlyPremium(table, { age: 150, coverage: 100000, tobacco: false })).toBe(161);
  });
});
