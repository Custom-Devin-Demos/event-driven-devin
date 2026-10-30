jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { startQuote, buildQuote, normalizeApplicant } = require('../app/services/verticals/957da0c9');
const { PRODUCT_CATALOG, INTENT_TO_PRODUCT } = require('../app/services/verticals/957da0c9-products');
const { RATE_TABLES, rateTableFor } = require('../app/services/verticals/957da0c9-rates');

const APPLICANT = { age: 38, coverage: 500000, tobacco: false, gender: 'female' };

describe('957da0c9 homepage quote engine', () => {
  beforeEach(() => jest.clearAllMocks());

  test('every catalog rating basis has a rate table', () => {
    for (const product of PRODUCT_CATALOG) {
      expect(RATE_TABLES).toHaveProperty([product.ratingBasis]);
      expect(Array.isArray(RATE_TABLES[product.ratingBasis].bands)).toBe(true);
    }
  });

  test.each(PRODUCT_CATALOG.map((p) => [p.code, p]))('prices one quote for %s', async (code, product) => {
    const quote = await startQuote({ selection: code, entryPoint: 'get-a-quote', applicant: APPLICANT });
    expect(quote.product).toBe(product.code);
    expect(quote.productName).toBe(product.name);
    expect(quote.termYears).toBe(product.defaultTerm);
    expect(Number.isFinite(quote.monthlyPremium)).toBe(true);
    expect(quote.monthlyPremium).toBeGreaterThan(0);
    expect(quote.annualPremium).toBeCloseTo(quote.monthlyPremium * 12, 2);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('reproduces the alerted request (LIFE, term-life, age 38, $500k, non-tobacco)', async () => {
    const quote = await startQuote({ selection: 'LIFE', entryPoint: 'unknown', applicant: APPLICANT });
    expect(quote.product).toBe('LIFE');
    expect(quote.coverage).toBe(500000);
    expect(quote.monthlyPremium).toBe(42);
  });

  test('every homepage intent resolves to a priceable product', async () => {
    for (const intent of Object.keys(INTENT_TO_PRODUCT)) {
      const quote = await startQuote({ selection: intent, applicant: APPLICANT, report: false });
      expect(quote.product).toBe(INTENT_TO_PRODUCT[intent]);
    }
  });

  test('missing or malformed applicant falls back to defaults and still prices', async () => {
    for (const applicant of [undefined, null, {}, { age: 'abc', coverage: -5 }]) {
      const quote = await startQuote({ selection: '', applicant, report: false });
      expect(quote.product).toBe('LIFE');
      expect(quote.monthlyPremium).toBeGreaterThan(0);
    }
  });

  test('age beyond the last band and coverage below minimum still price', () => {
    for (const product of PRODUCT_CATALOG) {
      const quote = buildQuote(product, normalizeApplicant({ age: 130, coverage: 1, tobacco: true }));
      expect(quote.monthlyPremium).toBeGreaterThan(0);
      expect(quote.coverage).toBe(RATE_TABLES[product.ratingBasis].minCoverage);
    }
  });

  test('unknown rating basis raises a descriptive error instead of a TypeError', () => {
    expect(() => rateTableFor('termLife')).toThrow('No rate table for rating basis "termLife"');
    expect(() => rateTableFor(undefined)).toThrow(/No rate table/);
    expect(() => rateTableFor('toString')).toThrow(/No rate table/);
    expect(() => buildQuote({ code: 'X', ratingBasis: 'nope' }, APPLICANT)).not.toThrow(TypeError);
  });
});
