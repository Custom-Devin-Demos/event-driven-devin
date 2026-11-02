/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/b62bfb77');
const {
  runRateCheck,
  monthlyPaymentCents,
  LOAN_PROGRAMS,
  ALL_PROGRAMS,
  PROGRAM_SCOPES,
  PRICING_DESK_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/b62bfb77');

const ORIGINAL_LATENCY = [...PRICING_DESK_POLICY.latencyMs];
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
  PRICING_DESK_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Rocket Mortgage rate check', () => {
  test('prices every loan program in order for the default "All loan programs" scope', async () => {
    PRICING_DESK_POLICY.latencyMs = [1, 3];

    const result = await runRateCheck({});

    expect(result.success).toBe(true);
    expect(result.quoteId).toMatch(/^RKT-[0-9A-F]{8}$/);
    expect(result.loanAmount).toBe(340000);
    expect(result.scope).toEqual({ key: 'all', label: 'All loan programs (14)' });
    expect(result.creditBand.key).toBe('excellent');
    expect(result.programsQuoted).toBe(14);
    expect(result.quotes.map((q) => q.program)).toEqual(ALL_PROGRAMS);

    for (const q of result.quotes) {
      expect(q.label).toBe(LOAN_PROGRAMS[q.program].label);
      expect(q.status).toBe('priced');
      expect(q.apr).toBeGreaterThanOrEqual(q.rate);
      expect(q.monthlyPaymentCents).toBe(monthlyPaymentCents(34000000, q.rate, q.termYears));
    }

    const priced = result.quotes.filter((q) => q.status === 'priced');
    expect(result.summary.eligiblePrograms).toBe(priced.length);
    expect(result.summary.lowestRate.rate).toBe(Math.min(...priced.map((q) => q.rate)));
    expect(result.summary.lowestPayment.monthlyPaymentCents)
      .toBe(Math.min(...priced.map((q) => q.monthlyPaymentCents)));
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('marks programs whose minimum down payment is not met as not eligible', async () => {
    PRICING_DESK_POLICY.latencyMs = [1, 2];

    const result = await runRateCheck({ homePrice: 400000, downPayment: 8000 });
    const byKey = Object.fromEntries(result.quotes.map((q) => [q.program, q]));

    expect(byKey.oneplus.status).toBe('priced');
    expect(byKey.va30.status).toBe('priced');
    expect(byKey.conv30.status).toBe('not_eligible');
    expect(byKey.jumbo30.reason).toBe('Requires at least 10% down');
    expect(byKey.conv30.monthlyPaymentCents).toBeNull();
  });

  test('does not round a down payment just below a program minimum up to eligibility', async () => {
    PRICING_DESK_POLICY.latencyMs = [1, 2];

    const result = await runRateCheck({ homePrice: 425000, downPayment: 14705, scope: 'fha30' });

    expect(result.quotes[0].status).toBe('not_eligible');
    expect(result.quotes[0].reason).toBe('Requires at least 3.5% down');
  });

  test('treats a down payment exactly at a program minimum as eligible', async () => {
    PRICING_DESK_POLICY.latencyMs = [1, 2];

    const result = await runRateCheck({ homePrice: 50002, downPayment: 1750.07, scope: 'fha30' });

    expect(result.quotes[0].status).toBe('priced');
  });

  test.each([
    ['conv30', 'excellent'],
    ['fha30', 'good'],
    ['va15', 'fair'],
  ])('prices a single program for scope %p (%p credit) quickly', async (scope, creditBand) => {
    PRICING_DESK_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/b62bfb77/rate-check', {
      name: 'Jordan Lee', homePrice: 425000, downPayment: 85000, zip: '48226', creditBand, scope,
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scope).toEqual({ key: scope, label: PROGRAM_SCOPES[scope].label });
    expect(body.programsQuoted).toBe(1);
    expect(body.quotes.map((q) => q.program)).toEqual([scope]);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('single-program quotes match the same program in the full rate check', async () => {
    PRICING_DESK_POLICY.latencyMs = [1, 2];

    const full = await runRateCheck({ zip: '90210', creditBand: 'good' });
    const single = await runRateCheck({ zip: '90210', creditBand: 'good', scope: 'arm76' });

    expect(single.quotes[0]).toEqual(full.quotes.find((q) => q.program === 'arm76'));
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    PRICING_DESK_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/b62bfb77/rate-check', {
      name: 'Jordan Lee',
      homePrice: 425000,
      downPayment: 85000,
      zip: '48226',
      creditBand: 'excellent',
      scope: 'conv15',
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
    expect(alert.issueTitle).toContain('POST /api/b62bfb77/rate-check took');
    expect(alert.customer).toBe('b62bfb77');
    expect(alert.service).toBe('customer-b62bfb77-rate-check');
    expect(alert.culprit).toBe('app/services/verticals/b62bfb77.js — priceLoanPrograms');
    expect(alert.verticalLabel).toBe('Rocket Mortgage Rate Check');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('jordan.lee@example.com');
    expect(alert.promptAppendix).toContain('priceLoanPrograms');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/b62bfb77/rate-check' },
      { key: 'service', value: 'customer-b62bfb77-rate-check' },
      { key: 'scope', value: 'conv15' },
      { key: 'credit_band', value: 'excellent' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.quoteId,
      durationMs: body.durationMs,
      budgetMs: 1,
      programsQuoted: 1,
      datadogMetric: 'rate_check.latency',
    }));
  });

  test('rejects invalid rate checks through the route', async () => {
    const base = {
      name: 'Jordan Lee', homePrice: 425000, downPayment: 85000, zip: '48226', creditBand: 'excellent', scope: 'all',
    };
    const invalidRequests = [
      { ...base, name: '' },
      { ...base, name: 'x' },
      { ...base, homePrice: 1000 },
      { ...base, homePrice: '' },
      { ...base, homePrice: 'abc' },
      { ...base, downPayment: 425000 },
      { ...base, downPayment: -1 },
      { ...base, homePrice: 50000, downPayment: 1499.999 },
      { ...base, homePrice: 425000.005 },
      { ...base, zip: '4822' },
      { ...base, zip: 'ABCDE' },
      { ...base, creditBand: 'poor' },
      { ...base, scope: 'heloc' },
      { ...base, scope: '' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request('POST', '/api/b62bfb77/rate-check', body);
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('RATE_CHECK_INVALID');
      expect(response).toHaveProperty('requestId');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns program, scope and credit band metadata', async () => {
    const { status, body } = await request('GET', '/api/b62bfb77/programs');

    expect(status).toBe(200);
    expect(body.programs.map((p) => p.key)).toEqual(ALL_PROGRAMS);
    expect(body.scopeOptions[0]).toEqual({ key: 'all', label: 'All loan programs (14)', programCount: 14 });
    expect(body.scopeOptions).toHaveLength(15);
    expect(body.creditBands.map((b) => b.key)).toEqual(['excellent', 'good', 'fair']);
  });
});
