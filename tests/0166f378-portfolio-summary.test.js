/* global describe, expect, test, jest, beforeEach, afterAll, setImmediate */
const http = require('http');
const express = require('express');

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

process.env.SNOWFLAKE_0166F378_MODE = 'emulator';

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const service = require('../app/services/verticals/0166f378');
const router = require('../app/routes/verticals/0166f378');
const { PORTFOLIO } = require('../app/services/verticals/0166f378-portfolio');

const { LATENCY_SLO } = service;
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;

function get(path, headers = {}) {
  const app = express();
  app.use(express.json());
  app.use(router);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const req = http.request({
        host: '127.0.0.1', port, path, method: 'GET', headers,
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) })));
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end();
    });
  });
}

async function flush() {
  await new Promise((resolve) => { setImmediate(resolve); });
  await new Promise((resolve) => { setImmediate(resolve); });
}

beforeEach(() => {
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
  service.resetAlertCooldown();
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
});

afterAll(() => {
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
});

describe('Fidelity Portfolio Summary (0166f378)', () => {
  jest.setTimeout(30000);

  test('config endpoint publishes the latency budget and accounts', async () => {
    const res = await get('/api/0166f378/config');
    expect(res.status).toBe(200);
    expect(res.body.latencyBudgetMs).toBe(ORIGINAL_BUDGET);
    expect(res.body.accounts).toHaveLength(PORTFOLIO.accounts.length);
    expect(res.body.snowflakeMode).toBe('emulator');
  });

  test('returns one priced position per holding with account and portfolio totals', async () => {
    LATENCY_SLO.budgetMs = 60000;
    const res = await get('/api/0166f378/portfolio-summary?reports=off');
    expect(res.status).toBe(200);
    const { body } = res;
    expect(body.success).toBe(true);
    expect(body.totals.positionCount).toBe(PORTFOLIO.positions.length);
    const positions = body.accounts.flatMap((a) => a.positions);
    expect(new Set(positions.map((p) => p.positionId)).size).toBe(PORTFOLIO.positions.length);
    positions.forEach((p) => {
      expect(p.lastPrice).toBeGreaterThan(0);
      expect(p.marketValue).toBeCloseTo(p.quantity * p.lastPrice, 0);
    });
    expect(body.totals.marketValue).toBeCloseTo(body.accounts.reduce((s, a) => s + a.marketValue, 0), 1);
    expect(body.backend.snowflake.mode).toBe('emulator');
    expect(body.backend.snowflake.queryId).toMatch(/^emu-/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('reports a latency breach with the Snowflake query id and profile, once per cooldown', async () => {
    LATENCY_SLO.budgetMs = 0;
    const res = await get('/api/0166f378/portfolio-summary?devinEmail=demo@example.com');
    expect(res.status).toBe(200);
    expect(res.body.backend.breached).toBe(true);
    await flush();

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('0166f378');
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.issueTitle).toBe(`LatencyBudgetExceeded: GET /api/0166f378/portfolio-summary took ${res.body.backend.durationMs}ms (budget 0ms)`);
    expect(alert.extra.snowflakeQueryId).toBe(res.body.backend.snowflake.queryId);
    expect(alert.extra.partitionsTotal).toBeGreaterThan(0);
    expect(alert.promptAppendix).toContain('0166f378-positions-query.js');
    expect(alert.promptAppendix).toContain(res.body.backend.snowflake.queryId);

    const second = await get('/api/0166f378/portfolio-summary');
    expect(second.body.backend.breached).toBe(true);
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('reproduction requests never page anyone', async () => {
    LATENCY_SLO.budgetMs = 0;
    const res = await get('/api/0166f378/portfolio-summary', { 'x-synthetic': '1' });
    expect(res.body.backend.breached).toBe(true);
    await flush();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
