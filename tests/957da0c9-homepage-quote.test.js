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

jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { startQuote, buildQuote } = require('../app/services/verticals/957da0c9');
const { PRODUCT_CATALOG, INTENT_TO_PRODUCT } = require('../app/services/verticals/957da0c9-products');
const { RATE_TABLES } = require('../app/services/verticals/957da0c9-rates');

describe('957da0c9 homepage quote engine', () => {
  beforeEach(() => jest.clearAllMocks());

  test('every catalog product has a rate table for its ratingBasis', () => {
    for (const product of PRODUCT_CATALOG) {
      expect(RATE_TABLES[product.ratingBasis]).toBeDefined();
    }
  });

  test.each(PRODUCT_CATALOG.map((p) => [p.code, p]))('prices one quote for %s', async (code, product) => {
    const quote = await startQuote({ selection: code, entryPoint: 'test', applicant: { age: 38, coverage: 500000 } });
    expect(quote.product).toBe(code);
    expect(quote.productName).toBe(product.name);
    expect(quote.termYears).toBe(product.defaultTerm);
    expect(Number.isFinite(quote.monthlyPremium)).toBe(true);
    expect(quote.monthlyPremium).toBeGreaterThan(0);
    expect(quote.annualPremium).toBeCloseTo(quote.monthlyPremium * 12, 1);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('alert scenario: LIFE from nav:Insurance prices term-life', async () => {
    const quote = await startQuote({ selection: 'insurance', entryPoint: 'nav:Insurance', applicant: {} });
    expect(quote.product).toBe('LIFE');
    expect(quote.monthlyPremium).toBeGreaterThan(0);
  });

  test.each([undefined, '', 'unknown-tile', ...Object.keys(INTENT_TO_PRODUCT)])('selection %p resolves to a priceable product', async (selection) => {
    const quote = await startQuote({ selection, applicant: null });
    expect(quote.monthlyPremium).toBeGreaterThan(0);
  });

  test('applies minimum coverage and tobacco load', () => {
    const life = PRODUCT_CATALOG.find((p) => p.code === 'LIFE');
    const base = buildQuote(life, { age: 38, coverage: 1, tobacco: false });
    const smoker = buildQuote(life, { age: 38, coverage: 1, tobacco: true });
    expect(base.coverage).toBe(RATE_TABLES['term-life'].minCoverage);
    expect(smoker.monthlyPremium).toBeGreaterThan(base.monthlyPremium);
  });

  test('missing rate table fails with a descriptive error instead of a TypeError', () => {
    expect(() => buildQuote({ code: 'X', ratingBasis: 'nope', defaultTerm: 1 }, { age: 30, coverage: 1000, tobacco: false }))
      .toThrow('No rate table for rating basis "nope" (product X)');
  });
});
