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
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));

const express = require('express');
const http = require('http');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { startQuote, buildQuote } = require('../app/services/verticals/957da0c9');
const { PRODUCT_CATALOG, INTENT_TO_PRODUCT } = require('../app/services/verticals/957da0c9-products');
const { RATE_TABLES, rateTableFor, monthlyPremium } = require('../app/services/verticals/957da0c9-rates');
const router = require('../app/routes/verticals/957da0c9');

const applicant = { age: 38, coverage: 500000, tobacco: false, gender: 'female' };

beforeEach(() => jest.clearAllMocks());

describe('957da0c9 homepage quote engine', () => {
  test.each(PRODUCT_CATALOG.map((p) => [p.code, p]))('prices a quote for catalog product %s', async (code, product) => {
    const quote = await startQuote({ selection: code, entryPoint: 'test', applicant, report: false });
    expect(quote.product).toBe(code);
    expect(quote.productName).toBe(product.name);
    expect(quote.termYears).toBe(product.defaultTerm);
    expect(Number.isFinite(quote.monthlyPremium)).toBe(true);
    expect(quote.monthlyPremium).toBeGreaterThan(0);
    expect(quote.annualPremium).toBeCloseTo(quote.monthlyPremium * 12, 2);
    expect(quote.coverage).toBeGreaterThanOrEqual(RATE_TABLES[product.ratingBasis].minCoverage);
  });

  test('every catalog rating basis has a rate table', () => {
    PRODUCT_CATALOG.forEach((p) => {
      expect(RATE_TABLES[p.ratingBasis]).toBeDefined();
      expect(Array.isArray(RATE_TABLES[p.ratingBasis].bands)).toBe(true);
    });
  });

  test('reproduces the alert: RETIREMENT (fixed-annuity) from nav:Investments no longer throws', async () => {
    const quote = await startQuote({ selection: 'investments', entryPoint: 'nav:Investments', applicant });
    expect(quote.product).toBe('RETIREMENT');
    // 500000 / 1000 * 0.0421 (age 38 band)
    expect(quote.monthlyPremium).toBe(21.05);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('every homepage intent resolves to a priceable product', async () => {
    const intents = [...Object.keys(INTENT_TO_PRODUCT), '', 'unknown-tile', undefined];
    await Promise.all(intents.map(async (selection) => {
      const quote = await startQuote({ selection, applicant, report: false });
      expect(quote.monthlyPremium).toBeGreaterThan(0);
    }));
  });

  test('missing or invalid applicant falls back to defaults and still prices', async () => {
    const quote = await startQuote({ selection: 'RETIREMENT', applicant: undefined, report: false });
    expect(quote.coverage).toBe(500000);
    expect(quote.monthlyPremium).toBe(21.05);
    const junk = await startQuote({ selection: 'LIFE', applicant: { age: 'abc', coverage: -5 }, report: false });
    expect(junk.monthlyPremium).toBeGreaterThan(0);
  });

  test('coverage below the table minimum is raised to the minimum', () => {
    const product = PRODUCT_CATALOG.find((p) => p.code === 'RETIREMENT');
    const quote = buildQuote(product, { ...applicant, coverage: 1000 });
    expect(quote.coverage).toBe(25000);
  });

  test('ages above the last band use the last band', () => {
    const table = rateTableFor('fixed-annuity');
    expect(monthlyPremium(table, { age: 200, coverage: 100000, tobacco: false })).toBe(5.15);
  });

  test('rateTableFor rejects unknown, camelCase, and prototype keys with a clear error', () => {
    ['fixedAnnuity', 'unknown', undefined, null, '__proto__', 'toString'].forEach((basis) => {
      expect(() => rateTableFor(basis)).toThrow(/No rate table for rating basis/);
    });
  });
});

describe('POST /api/957da0c9/quotes', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll(() => new Promise((resolve) => { server.close(() => resolve()); }));

  function post(body) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(`${baseUrl}/api/957da0c9/quotes`, {
        method: 'POST',
        agent: false,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), Connection: 'close' },
      }, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject);
      req.end(payload);
    });
  }

  test('returns 200 with a priced quote for the alerting request', async () => {
    const res = await post({ selection: 'investments', entryPoint: 'nav:Investments', applicant });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.quote.product).toBe('RETIREMENT');
    expect(res.body.quote.monthlyPremium).toBe(21.05);
  });
});
