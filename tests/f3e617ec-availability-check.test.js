/* global describe, expect, test, jest, beforeEach, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { resetLatencyAlertCooldowns } = require('../app/services/latency-alert-cooldown');
const routes = require('../app/routes/verticals/f3e617ec');
const {
  checkAvailability,
  selectBestAvailability,
  SECURITIES,
  LENDER_SCOPES,
  AGENT_LENDER_NETWORK,
  LENDER_FEED_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/f3e617ec');

const ORIGINAL_LATENCY = [...LENDER_FEED_POLICY.latencyMs];
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
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path,
          method,
          headers,
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
          });
        },
      );
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

async function postLatencyBreach() {
  const response = await request('POST', '/api/f3e617ec/availability-check', {
    scope: 'preferred',
    devinUserId: 'clerk-user_demo',
    devinOrgId: 'org_demo',
    devinEmail: 'jordan.lee@example.com',
  });
  await tick();
  return response;
}

beforeEach(() => resetLatencyAlertCooldowns());

afterEach(() => {
  LENDER_FEED_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('EquiLend availability check', () => {
  test('returns a consolidated locate across every lender in network order', async () => {
    LENDER_FEED_POLICY.latencyMs = [1, 3];

    const result = await checkAvailability();
    const lendable = result.lenderFeeds.filter((feed) => feed.lendableShares > 0);
    const bestFee = Math.min(...lendable.map((feed) => feed.feeBps));
    const expectedLender = lendable.find((feed) => feed.feeBps === bestFee).lender;
    const total = result.lenderFeeds.reduce((sum, feed) => sum + feed.lendableShares, 0);

    expect(result.success).toBe(true);
    expect(result.locateId).toMatch(/^EQL-[0-9A-F]{8}$/);
    expect(result.security).toEqual({
      ticker: 'AAPL',
      label: 'Apple Inc.',
      isin: 'US0378331005',
      market: 'US Equities',
    });
    expect(result.quantity).toBe(250000);
    expect(result.scope).toEqual({
      key: 'consolidated',
      label: 'All connected agent lenders (consolidated)',
    });
    expect(result.lendersPolled).toBe(14);
    expect(result.lenderFeeds.map((feed) => feed.lender)).toEqual(AGENT_LENDER_NETWORK);
    expect(result.bestLender).toBe(expectedLender);
    expect(result.bestFeeBps).toBe(bestFee);
    expect(result.totalLendableShares).toBe(total);
    expect(result.status).toBe('LOCATED');
    expect(result.locatedShares).toBe(250000);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('breaks fee ties by earliest lender order', () => {
    const feeds = [
      { lender: 'FIRST', lendableShares: 100, feeBps: 25 },
      { lender: 'SECOND', lendableShares: 100, feeBps: 25 },
    ];

    expect(selectBestAvailability(feeds)).toEqual({
      bestLender: 'FIRST',
      bestFeeBps: 25,
      totalLendableShares: 200,
    });
  });

  test.each(['preferred', 'internal'])('polls a single lender feed for the %s scope', async (scope) => {
    LENDER_FEED_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/f3e617ec/availability-check', { scope });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scope).toEqual({ key: scope, label: LENDER_SCOPES[scope].label });
    expect(body.lendersPolled).toBe(1);
    expect(body.lenderFeeds.map((feed) => feed.lender)).toEqual(LENDER_SCOPES[scope].lenders);
    expect(body.bestLender).toBe(LENDER_SCOPES[scope].lenders[0]);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('reports a partial locate when demand exceeds lendable supply', async () => {
    LENDER_FEED_POLICY.latencyMs = [1, 3];

    const result = await checkAvailability({ ticker: 'BYND', quantity: 50000000, scope: 'internal' });

    expect(result.status).toBe('PARTIAL');
    expect(result.locatedShares).toBe(result.totalLendableShares);
    expect(result.bestFeeBps).toBeGreaterThanOrEqual(SECURITIES.BYND.baseFeeBps);
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    LENDER_FEED_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/f3e617ec/availability-check', {
      scope: 'preferred',
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
    expect(alert.customer).toBe('f3e617ec');
    expect(alert.service).toBe('customer-f3e617ec-availability-check');
    expect(alert.culprit).toBe('app/services/verticals/f3e617ec.js — collectLenderAvailability');
    expect(alert.verticalLabel).toBe('EquiLend Availability Check');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/f3e617ec/availability-check' },
      { key: 'service', value: 'customer-f3e617ec-availability-check' },
      { key: 'ticker', value: 'AAPL' },
      { key: 'scope', value: 'preferred' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.locateId,
      durationMs: body.durationMs,
      budgetMs: 1,
      lendersPolled: 1,
    }));
  });

  test('suppresses a second latency-breach session during the cooldown', async () => {
    LENDER_FEED_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;

    await postLatencyBreach();
    await postLatencyBreach();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('releases the cooldown when session creation returns null', async () => {
    LENDER_FEED_POLICY.latencyMs = [2, 4];
    LATENCY_SLO.budgetMs = 1;
    createSessionAndAlert.mockResolvedValueOnce(null);

    await postLatencyBreach();
    await postLatencyBreach();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('rejects invalid locate requests through the route', async () => {
    const invalidRequests = [
      { ticker: 'XXX' },
      { quantity: 50 },
      { quantity: 1000.5 },
      { scope: 'invalid' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request('POST', '/api/f3e617ec/availability-check', body);
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('LOCATE_REQUEST_INVALID');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns security and lender-scope metadata', async () => {
    const { status, body } = await request('GET', '/api/f3e617ec/securities');

    expect(status).toBe(200);
    expect(body.securities.map((security) => security.ticker)).toEqual(Object.keys(SECURITIES));
    expect(body.lenderScopes).toEqual(Object.entries(LENDER_SCOPES).map(([key, scope]) => ({
      key,
      label: scope.label,
      lenderCount: scope.lenders.length,
    })));
  });
});
