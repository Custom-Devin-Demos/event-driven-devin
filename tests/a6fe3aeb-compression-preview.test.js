/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/a6fe3aeb');
const {
  runCompressionPreview,
  COUNTERPARTIES,
  ALL_COUNTERPARTIES,
  COUNTERPARTY_SCOPES,
  ASSET_CLASSES,
  PORTFOLIO_FEED_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/a6fe3aeb');

const ORIGINAL_LATENCY = [...PORTFOLIO_FEED_POLICY.latencyMs];
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;

const BASE = {
  name: 'Alex Morgan',
  institution: 'Global Markets Bank',
  email: 'alex.morgan@globalmarkets.example',
  assetClass: 'irs',
  scope: 'all',
};

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
  PORTFOLIO_FEED_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Capitolis compression preview', () => {
  test('analyzes every counterparty in order for the default "All counterparties" scope', async () => {
    PORTFOLIO_FEED_POLICY.latencyMs = [1, 3];

    const result = await runCompressionPreview({});

    expect(result.success).toBe(true);
    expect(result.previewId).toMatch(/^CAP-[0-9A-F]{8}$/);
    expect(result.scope).toEqual({ key: 'all', label: 'All counterparties (14)' });
    expect(result.assetClass).toEqual({ key: 'irs', label: 'Interest Rate Swaps' });
    expect(result.counterpartiesAnalyzed).toBe(14);
    expect(result.counterparties.map((c) => c.counterparty)).toEqual(ALL_COUNTERPARTIES);

    for (const c of result.counterparties) {
      expect(c.label).toBe(COUNTERPARTIES[c.counterparty].label);
      expect(c.eliminatedNotionalUsdMm).toBeLessThan(c.grossNotionalUsdMm);
      expect(c.residualNotionalUsdMm).toBe(c.grossNotionalUsdMm - c.eliminatedNotionalUsdMm);
      expect(c.reductionPct).toBeGreaterThanOrEqual(ASSET_CLASSES.irs.compressionPct[0]);
      expect(c.reductionPct).toBeLessThanOrEqual(ASSET_CLASSES.irs.compressionPct[1]);
      expect(c.tradesTerminated).toBeLessThanOrEqual(c.tradeCount);
    }

    const s = result.summary;
    const gross = result.counterparties.reduce((sum, c) => sum + c.grossNotionalUsdMm, 0);
    const eliminated = result.counterparties.reduce((sum, c) => sum + c.eliminatedNotionalUsdMm, 0);
    expect(s.grossNotionalUsdMm).toBe(gross);
    expect(s.eliminatedNotionalUsdMm).toBe(eliminated);
    expect(s.residualNotionalUsdMm).toBe(gross - eliminated);
    expect(s.reductionPct).toBe(Math.round((eliminated / gross) * 1000) / 10);
    expect(s.topCounterparty.eliminatedNotionalUsdMm)
      .toBe(Math.max(...result.counterparties.map((c) => c.eliminatedNotionalUsdMm)));
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['atlantic', 'irs'],
    ['thames', 'fxfwd'],
    ['sakura', 'cds'],
  ])('previews a single counterparty for scope %p (%p) quickly', async (scope, assetClass) => {
    PORTFOLIO_FEED_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/a6fe3aeb/compression-preview', { ...BASE, scope, assetClass });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scope).toEqual({ key: scope, label: COUNTERPARTY_SCOPES[scope].label });
    expect(body.counterpartiesAnalyzed).toBe(1);
    expect(body.counterparties.map((c) => c.counterparty)).toEqual([scope]);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('single-counterparty results match the same counterparty in the full preview', async () => {
    PORTFOLIO_FEED_POLICY.latencyMs = [1, 2];

    const full = await runCompressionPreview({ ...BASE, assetClass: 'fxopt' });
    const single = await runCompressionPreview({ ...BASE, assetClass: 'fxopt', scope: 'lumiere' });

    expect(single.counterparties[0]).toEqual(full.counterparties.find((c) => c.counterparty === 'lumiere'));
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    PORTFOLIO_FEED_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/a6fe3aeb/compression-preview', {
      ...BASE,
      scope: 'hudson',
      devinUserId: 'clerk-user_demo',
      devinOrgId: 'org_demo',
      devinEmail: 'alex.morgan@example.com',
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.durationMs).toBeGreaterThan(LATENCY_SLO.budgetMs);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.issueTitle).toContain('POST /api/a6fe3aeb/compression-preview took');
    expect(alert.customer).toBe('a6fe3aeb');
    expect(alert.service).toBe('customer-a6fe3aeb-compression-preview');
    expect(alert.culprit).toBe('app/services/verticals/a6fe3aeb.js — fetchCounterpartyPortfolios');
    expect(alert.verticalLabel).toBe('Capitolis Compression Preview');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('alex.morgan@example.com');
    expect(alert.promptAppendix).toContain('fetchCounterpartyPortfolios');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/a6fe3aeb/compression-preview' },
      { key: 'service', value: 'customer-a6fe3aeb-compression-preview' },
      { key: 'scope', value: 'hudson' },
      { key: 'asset_class', value: 'irs' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.previewId,
      durationMs: body.durationMs,
      budgetMs: 1,
      counterpartiesAnalyzed: 1,
      datadogMetric: 'compression_preview.latency',
    }));
  });

  test('rejects invalid previews through the route', async () => {
    const invalidRequests = [
      { ...BASE, name: '' },
      { ...BASE, name: 'x' },
      { ...BASE, institution: '' },
      { ...BASE, email: 'not-an-email' },
      { ...BASE, email: '' },
      { ...BASE, assetClass: 'equities' },
      { ...BASE, scope: 'unknownbank' },
      { ...BASE, scope: '' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request('POST', '/api/a6fe3aeb/compression-preview', body);
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('COMPRESSION_PREVIEW_INVALID');
      expect(response).toHaveProperty('requestId');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns counterparty, scope and asset class metadata', async () => {
    const { status, body } = await request('GET', '/api/a6fe3aeb/counterparties');

    expect(status).toBe(200);
    expect(body.counterparties.map((c) => c.key)).toEqual(ALL_COUNTERPARTIES);
    expect(body.scopeOptions[0]).toEqual({ key: 'all', label: 'All counterparties (14)', counterpartyCount: 14 });
    expect(body.scopeOptions).toHaveLength(15);
    expect(body.assetClasses.map((a) => a.key)).toEqual(Object.keys(ASSET_CLASSES));
  });
});
