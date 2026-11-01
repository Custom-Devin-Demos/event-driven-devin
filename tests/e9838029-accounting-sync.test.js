/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/e9838029');
const {
  runAccountingSync,
  CARDS,
  ALL_CARDS,
  CARD_SCOPES,
  DESTINATIONS,
  LEDGER_FETCH_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/e9838029');

const ORIGINAL_LATENCY = [...LEDGER_FETCH_POLICY.latencyMs];
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
  LEDGER_FETCH_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Capital on Tap accounting sync', () => {
  test('syncs every company card in order for the default "All company cards" scope', async () => {
    LEDGER_FETCH_POLICY.latencyMs = [1, 3];

    const result = await runAccountingSync({ business: 'Surewood Timber Co.' });

    expect(result.success).toBe(true);
    expect(result.syncId).toMatch(/^COT-[0-9A-F]{8}$/);
    expect(result.business).toBe('Surewood Timber Co.');
    expect(result.destination).toEqual({
      key: 'quickbooks',
      label: DESTINATIONS.quickbooks.label,
      account: DESTINATIONS.quickbooks.account,
    });
    expect(result.scope).toEqual({ key: 'all', label: 'All company cards (14)' });
    expect(result.cardsSynced).toBe(14);
    expect(result.results.map((r) => r.card)).toEqual(ALL_CARDS);

    for (const r of result.results) {
      expect(r.cardholder).toBe(CARDS[r.card].cardholder);
      expect(r.last4).toBe(CARDS[r.card].last4);
      expect(r.transactionsSynced).toBeGreaterThan(0);
      expect(r.amountCents).toBeGreaterThan(0);
      expect(r.cashBackCents).toBe(Math.round(r.amountCents * 0.015));
      expect(r.status === 'needs_receipts').toBe(r.needsReceipt > 0);
    }

    const { summary } = result;
    expect(summary.cardsSynced).toBe(14);
    expect(summary.transactionsSynced).toBe(result.results.reduce((s, r) => s + r.transactionsSynced, 0));
    expect(summary.amountCents).toBe(result.results.reduce((s, r) => s + r.amountCents, 0));
    expect(summary.cashBackCents).toBe(result.results.reduce((s, r) => s + r.cashBackCents, 0));
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns deterministic ledgers for the same business and destination', async () => {
    LEDGER_FETCH_POLICY.latencyMs = [1, 2];

    const a = await runAccountingSync({ business: 'Free State Flora', destination: 'xero' });
    const b = await runAccountingSync({ business: 'Free State Flora', destination: 'xero' });

    expect(a.results).toEqual(b.results);
    expect(a.summary).toEqual(b.summary);
  });

  test.each([
    ['c4417', 'quickbooks'],
    ['c2093', 'xero'],
    ['c7092', 'quickbooks'],
  ])('syncs a single card for scope %p to %p', async (scope, destination) => {
    LEDGER_FETCH_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/e9838029/accounting-sync', {
      business: 'Surewood Timber Co.',
      destination,
      scope,
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scope).toEqual({ key: scope, label: CARD_SCOPES[scope].label });
    expect(body.destination.key).toBe(destination);
    expect(body.cardsSynced).toBe(1);
    expect(body.results.map((r) => r.card)).toEqual([scope]);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('single-card results match the same card in the full sync', async () => {
    LEDGER_FETCH_POLICY.latencyMs = [1, 2];

    const full = await runAccountingSync({ business: 'Ground the Twist Cafe' });
    const single = await runAccountingSync({ business: 'Ground the Twist Cafe', scope: 'c5528' });

    expect(single.results[0]).toEqual(full.results.find((r) => r.card === 'c5528'));
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    LEDGER_FETCH_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/e9838029/accounting-sync', {
      business: 'Surewood Timber Co.',
      destination: 'xero',
      scope: 'c2093',
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
    expect(alert.issueTitle).toContain('POST /api/e9838029/accounting-sync took');
    expect(alert.customer).toBe('e9838029');
    expect(alert.service).toBe('customer-e9838029-accounting-sync');
    expect(alert.culprit).toBe('app/services/verticals/e9838029.js — syncCardLedgers');
    expect(alert.verticalLabel).toBe('Capital on Tap Accounting Sync');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('jordan.lee@example.com');
    expect(alert.promptAppendix).toContain('syncCardLedgers');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/e9838029/accounting-sync' },
      { key: 'service', value: 'customer-e9838029-accounting-sync' },
      { key: 'scope', value: 'c2093' },
      { key: 'destination', value: 'xero' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.syncId,
      durationMs: body.durationMs,
      budgetMs: 1,
      cardsSynced: 1,
      datadogMetric: 'accounting_sync.latency',
    }));
  });

  test('rejects invalid sync requests through the route', async () => {
    const invalidRequests = [
      { business: '' },
      { business: 'x' },
      { business: 'a'.repeat(121) },
      { business: 'Surewood Timber Co.', destination: 'sage' },
      { business: 'Surewood Timber Co.', scope: 'c0000' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request('POST', '/api/e9838029/accounting-sync', body);
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('ACCOUNTING_SYNC_INVALID');
      expect(response).toHaveProperty('requestId');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns card, scope and destination metadata', async () => {
    const { status, body } = await request('GET', '/api/e9838029/cards');

    expect(status).toBe(200);
    expect(body.cards).toHaveLength(14);
    expect(body.cards.map((c) => c.key)).toEqual(ALL_CARDS);
    expect(body.scopeOptions[0]).toEqual({ key: 'all', label: 'All company cards (14)', cardCount: 14 });
    expect(body.scopeOptions).toHaveLength(15);
    expect(body.destinations.map((d) => d.key)).toEqual(['quickbooks', 'xero']);
  });
});
