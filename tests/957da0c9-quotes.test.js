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

const express = require('express');
const http = require('http');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { startQuote, buildQuote } = require('../app/services/verticals/957da0c9');
const { PRODUCT_CATALOG, INTENT_TO_PRODUCT } = require('../app/services/verticals/957da0c9-products');
const { RATE_TABLES } = require('../app/services/verticals/957da0c9-rates');
const router = require('../app/routes/verticals/957da0c9');

function postJson(server, path, body) {
  return new Promise((resolve, reject) => {
    const { port } = server.address();
    const payload = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, path, method: 'POST',
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

beforeEach(() => jest.clearAllMocks());

describe('957da0c9 rate tables', () => {
  test.each(PRODUCT_CATALOG.map((p) => [p.code, p.ratingBasis]))(
    '%s rating basis %s has a rate table', (code, ratingBasis) => {
      expect(RATE_TABLES[ratingBasis]).toBeDefined();
      expect(RATE_TABLES[ratingBasis].bands.length).toBeGreaterThan(0);
    },
  );
});

describe('957da0c9 startQuote', () => {
  test.each(PRODUCT_CATALOG.map((p) => [p.code]))('prices one quote for %s', async (code) => {
    const quote = await startQuote({ selection: code, entryPoint: 'test', report: false });
    expect(quote.product).toBe(code);
    expect(Number.isFinite(quote.monthlyPremium)).toBe(true);
    expect(quote.monthlyPremium).toBeGreaterThan(0);
    expect(quote.annualPremium).toBeCloseTo(quote.monthlyPremium * 12, 1);
  });

  test('prices the alerting request (LIFE via "I am an individual or family")', async () => {
    const quote = await startQuote({
      selection: 'individual',
      entryPoint: 'iam:an individual or family',
      applicant: { age: 38, coverage: 500000, tobacco: false },
    });
    expect(quote.product).toBe('LIFE');
    expect(quote.monthlyPremium).toBe(42);
    expect(quote.coverage).toBe(500000);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each(Object.keys(INTENT_TO_PRODUCT))('homepage intent %s resolves to a priced quote', async (intent) => {
    const quote = await startQuote({ selection: intent, report: false });
    expect(quote.product).toBe(INTENT_TO_PRODUCT[intent]);
    expect(quote.monthlyPremium).toBeGreaterThan(0);
  });

  test('unknown or missing selection and applicant fall back to a priced LIFE quote', async () => {
    const quote = await startQuote({ selection: undefined, applicant: null, report: false });
    expect(quote.product).toBe('LIFE');
    expect(quote.monthlyPremium).toBeGreaterThan(0);
  });

  test('extreme ages and coverage below the minimum still price', () => {
    PRODUCT_CATALOG.forEach((product) => {
      [0, 1, 200].forEach((age) => {
        const quote = buildQuote(product, { age, coverage: 1, tobacco: true });
        expect(quote.monthlyPremium).toBeGreaterThan(0);
        expect(quote.coverage).toBe(RATE_TABLES[product.ratingBasis].minCoverage);
      });
    });
  });
});

describe('POST /api/957da0c9/quotes', () => {
  let server;
  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0, '127.0.0.1', done);
  });
  afterAll((done) => { server.close(done); });

  test.each(PRODUCT_CATALOG.map((p) => [p.code]))('returns 200 with a quote for %s', async (code) => {
    const res = await postJson(server, '/api/957da0c9/quotes', { selection: code, entryPoint: 'test', report: false });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.quote.product).toBe(code);
    expect(res.body.quote.monthlyPremium).toBeGreaterThan(0);
  });
});
