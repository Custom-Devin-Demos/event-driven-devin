jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(), recordTiming: jest.fn(),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { startQuote, buildQuote, normalizeApplicant } = require('../app/services/verticals/957da0c9');
const { PRODUCT_CATALOG, INTENT_TO_PRODUCT } = require('../app/services/verticals/957da0c9-products');
const { RATE_TABLES, rateTableFor, monthlyPremium } = require('../app/services/verticals/957da0c9-rates');

const APPLICANT = { age: 38, coverage: 500000, tobacco: false, gender: 'female' };

beforeEach(() => jest.clearAllMocks());

describe('957da0c9 homepage quote engine — catalog coverage', () => {
  test.each(PRODUCT_CATALOG.map((p) => [p.code, p]))('prices a quote for %s', async (code, product) => {
    const quote = await startQuote({ selection: code, entryPoint: 'test', applicant: APPLICANT });
    expect(quote.product).toBe(code);
    expect(quote.productName).toBe(product.name);
    expect(quote.termYears).toBe(product.defaultTerm);
    expect(Number.isFinite(quote.monthlyPremium)).toBe(true);
    expect(quote.monthlyPremium).toBeGreaterThan(0);
    expect(quote.annualPremium).toBeCloseTo(quote.monthlyPremium * 12, 2);
    expect(quote.quoteId).toMatch(/^GQ-[0-9A-F]{8}$/);
  });

  test('every catalog rating basis has a rate table', () => {
    PRODUCT_CATALOG.forEach((p) => {
      expect(RATE_TABLES[p.ratingBasis]).toBeDefined();
      expect(RATE_TABLES[p.ratingBasis].bands.length).toBeGreaterThan(0);
    });
  });

  test('no quote failure is reported to Sentry or Devin for any catalog product', async () => {
    await Promise.all(PRODUCT_CATALOG.map((p) => startQuote({ selection: p.code, applicant: APPLICANT })));
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('957da0c9 homepage quote engine — original failure', () => {
  test('employer entry point (DISABILITY / income-protection) from NODE-EXPRESS-DC now prices', async () => {
    const quote = await startQuote({ selection: 'employer', entryPoint: 'iam:an employer', applicant: APPLICANT });
    expect(quote.product).toBe('DISABILITY');
    // income-protection band for age 38 is 1.46 per $1,000 -> 500 units
    expect(quote.monthlyPremium).toBe(730);
    expect(quote.coverage).toBe(500000);
  });

  test.each(Object.keys(INTENT_TO_PRODUCT))('homepage entry point "%s" resolves to a priceable product', async (intent) => {
    const quote = await startQuote({ selection: intent, applicant: APPLICANT });
    expect(quote.product).toBe(INTENT_TO_PRODUCT[intent]);
  });
});

describe('957da0c9 homepage quote engine — edge cases', () => {
  test('unknown or missing selection falls back to LIFE and prices', async () => {
    await expect(startQuote({ selection: 'nonsense', applicant: APPLICANT })).resolves.toMatchObject({ product: 'LIFE' });
    await expect(startQuote({})).resolves.toMatchObject({ product: 'LIFE' });
  });

  test('missing or invalid applicant fields fall back to defaults', () => {
    expect(normalizeApplicant(undefined)).toEqual(APPLICANT);
    expect(normalizeApplicant({ age: 'abc', coverage: -5 })).toEqual(APPLICANT);
  });

  test('ages beyond the last band use the last band', () => {
    PRODUCT_CATALOG.forEach((p) => {
      const table = rateTableFor(p.ratingBasis);
      const last = table.bands[table.bands.length - 1];
      expect(monthlyPremium(table, { age: 200, coverage: 1000000, tobacco: false })).toBe(Math.round(last.rate * 1000 * 100) / 100);
    });
  });

  test('coverage below the table minimum is raised to the minimum', () => {
    PRODUCT_CATALOG.forEach((p) => {
      const quote = buildQuote(p, { age: 30, coverage: 1, tobacco: false });
      expect(quote.coverage).toBe(RATE_TABLES[p.ratingBasis].minCoverage);
      expect(quote.monthlyPremium).toBeGreaterThan(0);
    });
  });

  test('tobacco load increases premium where the table defines one', () => {
    const table = rateTableFor('term-life');
    const base = monthlyPremium(table, { age: 38, coverage: 500000, tobacco: false });
    expect(monthlyPremium(table, { age: 38, coverage: 500000, tobacco: true })).toBeCloseTo(base * table.tobaccoLoad, 1);
  });

  test('rateTableFor throws a descriptive error for an unknown rating basis', () => {
    expect(() => rateTableFor('incomeProtection')).toThrow("No rate table for rating basis 'incomeProtection'");
    expect(() => rateTableFor(undefined)).toThrow(/No rate table/);
  });
});
