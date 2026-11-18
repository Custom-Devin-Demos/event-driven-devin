/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/2fbca1a9');
const {
  quoteCoverage,
  selectBestQuote,
  PRODUCTS,
  PROVINCES,
  RATING_PROGRAMS,
  RATING_ENGINE_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/2fbca1a9');

const ORIGINAL_LATENCY = [...RATING_ENGINE_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(routes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request({
        host: '127.0.0.1', port, path, method, headers,
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => {
          server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
        });
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  RATING_ENGINE_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Definity coverage quote', () => {
  test('rates every program in order for the default all-companies auto quote', async () => {
    RATING_ENGINE_POLICY.latencyMs = [1, 3];

    const result = await quoteCoverage();
    const offered = result.programQuotes.filter((quote) => quote.offered);
    const lowest = Math.min(...offered.map((quote) => quote.annualPremium));

    expect(result.success).toBe(true);
    expect(result.quoteId).toMatch(/^DFN-[0-9A-F]{8}$/);
    expect(result.product).toEqual({ key: 'auto', label: 'Auto' });
    expect(result.province).toEqual({ key: 'ON', label: 'Ontario' });
    expect(result.postalCode).toBe('M5H 2N2');
    expect(result.channel).toEqual({ key: 'all', label: 'All Definity companies' });
    expect(result.programsRated).toBe(14);
    expect(result.programQuotes.map((quote) => quote.code)).toEqual(RATING_PROGRAMS.map((p) => p.code));
    expect(offered.map((quote) => quote.code)).toEqual(['DEF-AUTO-PREF', 'DEF-AUTO-STD', 'SON-AUTO', 'FAM-AUTO', 'TRV-AUTO']);
    expect(result.programsOffering).toBe(5);
    expect(result.bestQuote.annualPremium).toBe(lowest);
    expect(result.bestQuote.code).toBe(offered.find((quote) => quote.annualPremium === lowest).code);
    expect(result.currency).toBe('CAD');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('breaks premium ties by earliest program and skips declined programs', () => {
    const quotes = [
      { code: 'A', offered: false, annualPremium: null },
      { code: 'B', offered: true, annualPremium: 1200 },
      { code: 'C', offered: true, annualPremium: 1200 },
    ];
    expect(selectBestQuote(quotes).code).toBe('B');
    expect(selectBestQuote([quotes[0]])).toBeNull();
  });

  test.each([
    ['sonnet', 'auto', 'SON-AUTO'],
    ['family', 'home', 'FAM-HOME'],
    ['definity', 'farm', 'DEF-FARM'],
    ['petline', 'pet', 'PET-ACC-ILL'],
  ])('rates a single program for the %s channel (%s)', async (channel, product, code) => {
    RATING_ENGINE_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/2fbca1a9/coverage-quote', { channel, product });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.programsRated).toBe(1);
    expect(body.programQuotes.map((quote) => quote.code)).toEqual([code]);
    expect(body.bestQuote.code).toBe(code);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    RATING_ENGINE_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/2fbca1a9/coverage-quote', {
      channel: 'sonnet',
      devinUserId: 'clerk-user_demo',
      devinOrgId: 'org_demo',
      devinEmail: 'jordan.lee@example.com',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.durationMs).toBeGreaterThan(LATENCY_SLO.budgetMs);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.customer).toBe('2fbca1a9');
    expect(alert.service).toBe('customer-2fbca1a9-coverage-quote');
    expect(alert.culprit).toBe('app/services/verticals/2fbca1a9.js — collectProgramQuotes');
    expect(alert.verticalLabel).toBe('Definity Coverage Quote');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/2fbca1a9/coverage-quote' },
      { key: 'product', value: 'auto' },
      { key: 'channel', value: 'sonnet' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.quoteId,
      durationMs: body.durationMs,
      budgetMs: 1,
      programsRated: 1,
    }));
  });

  test.each([
    [{ product: 'boat' }, 'QUOTE_DETAILS_INVALID'],
    [{ province: 'ZZ' }, 'QUOTE_DETAILS_INVALID'],
    [{ postalCode: '12345' }, 'QUOTE_DETAILS_INVALID'],
    [{ channel: 'invalid' }, 'QUOTE_DETAILS_INVALID'],
    [{ channel: 'sonnet', product: 'pet' }, 'PRODUCT_NOT_OFFERED'],
  ])('rejects invalid quote details %p', async (payload, code) => {
    const { status, body } = await request('POST', '/api/2fbca1a9/coverage-quote', payload);

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe(code);
    expect(typeof body.error).toBe('string');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns quote options metadata', async () => {
    const { status, body } = await request('GET', '/api/2fbca1a9/quote-options');

    expect(status).toBe(200);
    expect(body.products.map((p) => p.key)).toEqual(Object.keys(PRODUCTS));
    expect(body.provinces.map((p) => p.key)).toEqual(Object.keys(PROVINCES));
    expect(body.channels.find((c) => c.key === 'sonnet').products).toEqual(['auto', 'home']);
  });
});
