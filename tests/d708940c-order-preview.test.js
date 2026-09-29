/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/d708940c');
const {
  previewOrder,
  selectBestExecution,
  SYMBOLS,
  ROUTING_OPTIONS,
  SMART_VENUES,
  VENUE_QUOTE_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/d708940c');

const ORIGINAL_LATENCY = [...VENUE_QUOTE_POLICY.latencyMs];
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

afterEach(() => {
  VENUE_QUOTE_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Interactive Brokers order preview', () => {
  test('returns a SMART best-execution preview with venue priority and NBBO', async () => {
    VENUE_QUOTE_POLICY.latencyMs = [1, 3];
    LATENCY_SLO.budgetMs = 3000;

    const result = await previewOrder();
    const bestAsk = Math.min(...result.venueQuotes.map((quote) => quote.ask));
    const bestBid = Math.max(...result.venueQuotes.map((quote) => quote.bid));
    const expectedVenue = result.venueQuotes.find((quote) => quote.ask === bestAsk).venue;

    expect(result.success).toBe(true);
    expect(result.previewId).toMatch(/^IBKR-[0-9A-F]{8}$/);
    expect(result.symbol).toEqual({
      key: 'AAPL',
      label: 'Apple Inc.',
      exchange: 'NASDAQ',
    });
    expect(result.side).toBe('BUY');
    expect(result.quantity).toBe(100);
    expect(result.orderType).toBe('MKT');
    expect(result.limitPrice).toBeNull();
    expect(result.routing).toEqual({
      key: 'smart',
      label: 'SMART (Best Execution)',
    });
    expect(result.venuesPolled).toBe(16);
    expect(result.venueQuotes.map((quote) => quote.venue)).toEqual(SMART_VENUES);
    expect(result.bestVenue).toBe(expectedVenue);
    expect(result.nbbo).toEqual({ bid: bestBid, ask: bestAsk });
    expect(result.nbbo.bid).toBeLessThan(result.nbbo.ask);
    expect(result.estimatedPrice).toBe(bestAsk);
    expect(result.commissionUsd).toBe(1);
    expect(result.estimatedTotalUsd).toBe(Math.round((100 * bestAsk + 1) * 100) / 100);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('breaks BUY and SELL price ties by earliest quote order', () => {
    const quotes = [
      { venue: 'FIRST', bid: 10.01, ask: 10.02 },
      { venue: 'SECOND', bid: 10.01, ask: 10.02 },
    ];

    expect(selectBestExecution('BUY', quotes)).toEqual({
      bestVenue: 'FIRST',
      nbbo: { bid: 10.01, ask: 10.02 },
    });
    expect(selectBestExecution('SELL', quotes).bestVenue).toBe('FIRST');
  });

  test('uses one venue and zero commission with IBKR Lite', async () => {
    VENUE_QUOTE_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/d708940c/order-preview', { routing: 'lite' });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.routing).toEqual({
      key: 'lite',
      label: 'IBKR Lite (commission-free)',
    });
    expect(body.venuesPolled).toBe(1);
    expect(body.venueQuotes.map((quote) => quote.venue)).toEqual(ROUTING_OPTIONS.lite.venues);
    expect(body.commissionUsd).toBe(0);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('uses one venue for directed NASDAQ routing', async () => {
    VENUE_QUOTE_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/d708940c/order-preview', { routing: 'nasdaq' });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.venuesPolled).toBe(1);
    expect(body.venueQuotes.map((quote) => quote.venue)).toEqual(['NASDAQ']);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('prices limit orders at their limit price', async () => {
    VENUE_QUOTE_POLICY.latencyMs = [1, 3];

    const result = await previewOrder({ orderType: 'LMT', limitPrice: 230 });

    expect(result.success).toBe(true);
    expect(result.limitPrice).toBe(230);
    expect(result.estimatedPrice).toBe(230);
    expect(result.estimatedTotalUsd).toBe(23001);
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    VENUE_QUOTE_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/d708940c/order-preview', {
      routing: 'nasdaq',
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
    expect(alert.customer).toBe('d708940c');
    expect(alert.service).toBe('customer-d708940c-order-preview');
    expect(alert.culprit).toBe('app/services/verticals/d708940c.js — collectVenueQuotes');
    expect(alert.verticalLabel).toBe('Interactive Brokers Order Preview');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/d708940c/order-preview' },
      { key: 'service', value: 'customer-d708940c-order-preview' },
      { key: 'symbol', value: 'AAPL' },
      { key: 'routing', value: 'nasdaq' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.previewId,
      durationMs: body.durationMs,
      budgetMs: 1,
      venuesPolled: 1,
    }));
  });

  test('rejects invalid order details through the route', async () => {
    const invalidRequests = [
      { symbol: 'XXX' },
      { quantity: 0 },
      { orderType: 'LMT' },
      { routing: 'invalid' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request(
        'POST',
        '/api/d708940c/order-preview',
        body,
      );
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('ORDER_DETAILS_INVALID');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns instrument and routing-option metadata', async () => {
    const { status, body } = await request('GET', '/api/d708940c/instruments');

    expect(status).toBe(200);
    expect(body.symbols).toEqual(Object.entries(SYMBOLS).map(([key, symbol]) => ({
      key,
      label: symbol.label,
      exchange: symbol.exchange,
    })));
    expect(body.routingOptions).toEqual(Object.entries(ROUTING_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      venueCount: option.venues.length,
    })));
  });
});
