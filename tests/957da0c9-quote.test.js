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

const express = require('express');
const http = require('http');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { startQuote, buildQuote, normalizeApplicant } = require('../app/services/verticals/957da0c9');
const { PRODUCT_CATALOG, INTENT_TO_PRODUCT } = require('../app/services/verticals/957da0c9-products');
const { RATE_TABLES, rateTableKey, rateTableFor } = require('../app/services/verticals/957da0c9-rates');
const router = require('../app/routes/verticals/957da0c9');

function postQuote(server, body) {
  const { port } = server.address();
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/api/957da0c9/quotes', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

describe('957da0c9 homepage quote engine', () => {
  beforeEach(() => jest.clearAllMocks());

  describe('regression: NODE-EXPRESS-DC (reading \'bands\')', () => {
    it.each(PRODUCT_CATALOG.map((p) => [p.code, p]))('prices one quote for %s', async (code, product) => {
      const quote = await startQuote({ selection: code, entryPoint: 'test', report: false });
      expect(quote.product).toBe(code);
      expect(quote.productName).toBe(product.name);
      expect(quote.termYears).toBe(product.defaultTerm);
      expect(Number.isFinite(quote.monthlyPremium)).toBe(true);
      expect(quote.monthlyPremium).toBeGreaterThan(0);
      expect(quote.annualPremium).toBeCloseTo(quote.monthlyPremium * 12, 1);
      expect(quote.quoteId).toMatch(/^GQ-[0-9A-F]{8}$/);
    });

    it('reproduces the alerted request (LIFE, term-life, "I am an individual or family")', async () => {
      const quote = await startQuote({
        selection: 'individual',
        entryPoint: 'iam:an individual or family',
        applicant: { age: 38, coverage: 500000, tobacco: false, gender: 'female' },
      });
      expect(quote.product).toBe('LIFE');
      expect(quote.monthlyPremium).toBe(42);
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    it('resolves a rate table for every rating basis in the catalog', () => {
      PRODUCT_CATALOG.forEach((p) => {
        const table = rateTableFor(p.ratingBasis);
        expect(Array.isArray(table.bands)).toBe(true);
        expect(table.bands.length).toBeGreaterThan(0);
      });
    });

    it('every homepage intent prices a quote', async () => {
      const intents = Object.keys(INTENT_TO_PRODUCT);
      const quotes = await Promise.all(intents.map((selection) => startQuote({ selection, report: false })));
      quotes.forEach((q, i) => expect(q.product).toBe(INTENT_TO_PRODUCT[intents[i]]));
    });

    it('POST /api/957da0c9/quotes returns 200 for every product', async () => {
      const app = express();
      app.use(express.json());
      app.use(router);
      const server = app.listen(0);
      try {
        for (const p of PRODUCT_CATALOG) {
          const res = await postQuote(server, { selection: p.code, entryPoint: 'test', report: false });
          expect(res.status).toBe(200);
          expect(res.body.ok).toBe(true);
          expect(res.body.quote.product).toBe(p.code);
        }
      } finally {
        server.close();
      }
    });
  });

  describe('edge cases', () => {
    it('maps kebab-case rating bases to rate table keys', () => {
      expect(rateTableKey('term-life')).toBe('termLife');
      expect(rateTableKey('income-protection')).toBe('incomeProtection');
      expect(rateTableKey('termLife')).toBe('termLife');
      expect(rateTableFor('dental-ppo')).toBe(RATE_TABLES.dentalPpo);
    });

    it('throws a descriptive error for an unknown rating basis instead of a TypeError', () => {
      expect(() => rateTableFor('long-term-care')).toThrow("No rate table for rating basis 'long-term-care'");
      expect(() => rateTableFor(undefined)).toThrow(/No rate table/);
      expect(() => buildQuote({ code: 'LTC', ratingBasis: 'long-term-care' }, normalizeApplicant({})))
        .not.toThrow(TypeError);
    });

    it('falls back to defaults for missing selection and applicant', async () => {
      const quote = await startQuote({ report: false });
      expect(quote.product).toBe('LIFE');
      expect(quote.coverage).toBe(500000);
    });

    it('applies minimum coverage and the oldest band for out-of-range applicants', () => {
      const dental = PRODUCT_CATALOG.find((p) => p.code === 'DENTAL');
      const quote = buildQuote(dental, normalizeApplicant({ age: 150, coverage: 1 }));
      expect(quote.coverage).toBe(RATE_TABLES.dentalPpo.minCoverage);
      expect(quote.monthlyPremium).toBe(Math.round(31.2 * 1.5 * 100) / 100);
    });

    it('applies the tobacco load', () => {
      const life = PRODUCT_CATALOG.find((p) => p.code === 'LIFE');
      const base = buildQuote(life, normalizeApplicant({ age: 38, coverage: 500000 }));
      const smoker = buildQuote(life, normalizeApplicant({ age: 38, coverage: 500000, tobacco: 'yes' }));
      expect(smoker.monthlyPremium).toBeCloseTo(base.monthlyPremium * RATE_TABLES.termLife.tobaccoLoad, 1);
    });
  });
});
