/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric, recordTiming } = require('../app/telemetry/datadog');
const routes = require('../app/routes/verticals/5d0fd49b');
const {
  quoteSweep,
  selectSweep,
  COLLECTIONS,
  MARKETPLACES,
  SWEEP_SOURCES,
  LATENCY_SLO,
  MARKETPLACE_QUOTE_POLICY,
} = require('../app/services/verticals/5d0fd49b');

const ORIGINAL_LATENCY = [...MARKETPLACE_QUOTE_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;
const UUID = /^[0-9a-f-]{36}$/;

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

afterEach(() => {
  MARKETPLACE_QUOTE_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
  incrementMetric.mockClear();
  recordTiming.mockClear();
});

describe('OpenSea sweep the floor quote', () => {
  test('aggregates every marketplace for the default Bored Ape sweep and picks the cheapest listings', async () => {
    MARKETPLACE_QUOTE_POLICY.latencyMs = [1, 3];

    const result = await quoteSweep();

    expect(result.success).toBe(true);
    expect(result.requestId).toMatch(UUID);
    expect(result.collection).toEqual({
      key: 'boredapeyachtclub',
      label: 'Bored Ape Yacht Club',
      chain: 'Ethereum',
      floorEth: COLLECTIONS.boredapeyachtclub.floorEth,
    });
    expect(result.source).toBe('all');
    expect(result.sourceLabel).toBe(SWEEP_SOURCES.all.label);
    expect(result.quantity).toBe(5);
    expect(result.marketplacesQueried).toBe(14);
    expect(result.marketplaceQuotes.map((quote) => quote.marketplace)).toEqual(Object.keys(MARKETPLACES));
    expect(result.listingsScanned).toBe(140);
    expect(result.sweep).toHaveLength(5);

    const prices = result.sweep.map((item) => item.priceEth);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    const cheapestQuote = Math.min(...result.marketplaceQuotes.map((quote) => quote.bestPriceEth));
    expect(prices[0]).toBe(cheapestQuote);
    for (const item of result.sweep) {
      expect(item.priceEth).toBeGreaterThanOrEqual(COLLECTIONS.boredapeyachtclub.floorEth);
      expect(item.marketplaceLabel).toBe(MARKETPLACES[item.marketplace].label);
    }

    const subtotal = Math.round(prices.reduce((sum, price) => sum + price, 0) * 10000) / 10000;
    expect(result.summary.itemsFilled).toBe(5);
    expect(result.summary.subtotalEth).toBe(subtotal);
    const itemFees = Math.round(result.sweep.reduce((sum, item) => sum + item.feeEth, 0) * 10000) / 10000;
    expect(result.summary.marketplaceFeesEth).toBe(itemFees);
    expect(result.summary.totalEth).toBeCloseTo(
      result.summary.subtotalEth + result.summary.marketplaceFeesEth + result.summary.gasEth,
      4,
    );
    expect(result.summary.totalUsd).toBeCloseTo(result.summary.totalEth * result.ethUsd, 1);
    expect(result.latencyBudgetMs).toBe(ORIGINAL_BUDGET);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(incrementMetric).toHaveBeenCalledWith('sweep_quote.success', expect.any(Object));
    expect(recordTiming).toHaveBeenCalledWith('sweep_quote.latency', result.latencyMs, expect.any(Object));
  });

  test('returns stable quotes for the same request', async () => {
    MARKETPLACE_QUOTE_POLICY.latencyMs = [1, 2];

    const first = await quoteSweep({ collection: 'argonauts', quantity: 3 });
    const second = await quoteSweep({ collection: 'argonauts', quantity: 3 });

    expect(second.sweep).toEqual(first.sweep);
    expect(second.summary).toEqual(first.summary);
  });

  test('breaks price ties by marketplace priority order', () => {
    const quotes = [
      { feePct: 1, listings: [{ tokenId: '1', marketplace: 'opensea', priceEth: 1 }] },
      { feePct: 0.5, listings: [{ tokenId: '2', marketplace: 'blur', priceEth: 1 }] },
    ];

    expect(selectSweep(quotes, 1)[0].tokenId).toBe('1');
  });

  test.each(['opensea', 'blur', 'magiceden'])('queries a single marketplace for the %s source', async (source) => {
    MARKETPLACE_QUOTE_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/5d0fd49b/sweep-quote', {
      collection: 'boredapeyachtclub',
      quantity: 5,
      source,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.source).toBe(source);
    expect(body.marketplacesQueried).toBe(1);
    expect(body.marketplaceQuotes.map((quote) => quote.marketplace)).toEqual([source]);
    expect(body.sweep.every((item) => item.marketplace === source)).toBe(true);
    expect(body.summary.itemsFilled).toBe(5);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns collection and source metadata', async () => {
    const { status, body } = await request('GET', '/api/5d0fd49b/collections');

    expect(status).toBe(200);
    expect(body.collections.map((collection) => collection.key)).toEqual(Object.keys(COLLECTIONS));
    expect(body.sourceOptions[0]).toEqual({
      key: 'all',
      label: SWEEP_SOURCES.all.label,
      marketplaceCount: 14,
    });
    expect(body.maxQuantity).toBe(10);
  });

  test('rejects invalid sweep requests through the route', async () => {
    const invalidRequests = [
      { collection: 'cryptopunks', quantity: 5, source: 'all' },
      { collection: 'boredapeyachtclub', quantity: 0, source: 'all' },
      { collection: 'boredapeyachtclub', quantity: 11, source: 'all' },
      { collection: 'boredapeyachtclub', quantity: '5', source: 'all' },
      { collection: 'boredapeyachtclub', quantity: 2.5, source: 'all' },
      { collection: 'boredapeyachtclub', quantity: 5, source: 'tensor' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request('POST', '/api/5d0fd49b/sweep-quote', body);
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('INVALID_SWEEP_REQUEST');
      expect(response.requestId).toMatch(UUID);
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('sends a Sentry warning and schedules the Devin alert on a latency breach', async () => {
    MARKETPLACE_QUOTE_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/5d0fd49b/sweep-quote', {
      collection: 'boredapeyachtclub',
      quantity: 5,
      source: 'opensea',
      devinUserId: 'clerk-user_demo',
      devinOrgId: 'org_demo',
      devinEmail: 'jordan.lee@example.com',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.latencyMs).toBeGreaterThan(LATENCY_SLO.budgetMs);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [sentryError, sentryContext] = Sentry.captureException.mock.calls[0];
    expect(sentryError.name).toBe('LatencyBudgetExceeded');
    expect(sentryError.message).toContain('POST /api/5d0fd49b/sweep-quote took');
    expect(sentryContext).toEqual(expect.objectContaining({
      level: 'warning',
      tags: expect.objectContaining({
        route: '/api/5d0fd49b/sweep-quote',
        service: 'customer-5d0fd49b-sweep-quote',
        alert_path: 'latency',
      }),
      extra: expect.objectContaining({
        requestId: body.requestId,
        durationMs: body.latencyMs,
        budgetMs: 1,
        marketplacesQueried: 1,
      }),
    }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.issueTitle).toContain('POST /api/5d0fd49b/sweep-quote took');
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.customer).toBe('5d0fd49b');
    expect(alert.service).toBe('customer-5d0fd49b-sweep-quote');
    expect(alert.culprit).toBe('app/services/verticals/5d0fd49b.js — aggregateMarketplaceListings');
    expect(alert.verticalLabel).toBe('OpenSea Sweep the Floor');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('jordan.lee@example.com');
    expect(alert.promptAppendix).toContain('aggregateMarketplaceListings');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/5d0fd49b/sweep-quote' },
      { key: 'service', value: 'customer-5d0fd49b-sweep-quote' },
      { key: 'source', value: 'opensea' },
      { key: 'duration_ms', value: String(body.latencyMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.requestId,
      budgetMs: 1,
      marketplacesQueried: 1,
      datadogMetric: 'sweep_quote.latency',
    }));
    expect(incrementMetric).toHaveBeenCalledWith('sweep_quote.latency_budget_breach', expect.any(Object));
  });
});
