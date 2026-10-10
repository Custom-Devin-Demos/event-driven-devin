/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/fe97a788');
const {
  runEndpointQuery,
  mergeShardResults,
  PIPES,
  TIME_RANGES,
  SCOPE_OPTIONS,
  CLUSTER_SHARDS,
  SHARD_READ_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/fe97a788');

const ORIGINAL_LATENCY = [...SHARD_READ_POLICY.latencyMs];
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
  SHARD_READ_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Tinybird endpoint query', () => {
  test('returns a distributed query with merged top rows and read totals', async () => {
    SHARD_READ_POLICY.latencyMs = [1, 3];

    const result = await runEndpointQuery();

    expect(result.success).toBe(true);
    expect(result.queryId).toMatch(/^TB-[0-9A-F]{8}$/);
    expect(result.pipe).toEqual({
      key: 'top_pages',
      label: 'top_pages',
      datasource: 'analytics_events',
      dimension: 'pathname',
      endpoint: '/v0/pipes/top_pages.json',
    });
    expect(result.timeRange).toEqual({ key: '24h', label: 'Last 24 hours' });
    expect(result.scope).toEqual({
      key: 'cluster',
      label: 'Distributed — all 14 shards',
    });
    expect(result.shardsQueried).toBe(14);
    expect(result.shardResults.map(({ shard }) => shard)).toEqual(CLUSTER_SHARDS);
    expect(result.rows).toHaveLength(5);
    expect(result.rows.map(({ hits }) => hits)).toEqual(
      [...result.rows.map(({ hits }) => hits)].sort((left, right) => right - left),
    );
    expect(result.rowsRead).toBe(
      result.shardResults.reduce((total, shard) => total + shard.rowsRead, 0),
    );
    expect(result.bytesRead).toBe(
      result.shardResults.reduce((total, shard) => total + shard.bytesRead, 0),
    );
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('breaks hit-count ties by the first-seen row order', () => {
    const shardResults = [
      { rows: [{ key: 'first', hits: 5 }, { key: 'second', hits: 10 }] },
      { rows: [{ key: 'first', hits: 5 }, { key: 'second', hits: 0 }, { key: 'third', hits: 20 }] },
    ];

    expect(mergeShardResults(shardResults)).toEqual([
      { key: 'third', hits: 20 },
      { key: 'first', hits: 10 },
      { key: 'second', hits: 10 },
    ]);
  });

  test.each(['shard', 'mv'])('queries one source for the %s scope through the route', async (scope) => {
    SHARD_READ_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/fe97a788/query', { scope });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scope).toEqual({ key: scope, label: SCOPE_OPTIONS[scope].label });
    expect(body.shardsQueried).toBe(1);
    expect(body.shardResults.map(({ shard }) => shard)).toEqual(SCOPE_OPTIONS[scope].shards);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    SHARD_READ_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/fe97a788/query', {
      scope: 'shard',
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
    expect(alert.customer).toBe('fe97a788');
    expect(alert.service).toBe('customer-fe97a788-endpoint-query');
    expect(alert.culprit).toBe('app/services/verticals/fe97a788.js — collectShardResults');
    expect(alert.verticalLabel).toBe('Tinybird Endpoint Query');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/fe97a788/query' },
      { key: 'service', value: 'customer-fe97a788-endpoint-query' },
      { key: 'pipe', value: 'top_pages' },
      { key: 'scope', value: 'shard' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.queryId,
      durationMs: body.durationMs,
      budgetMs: 1,
      shardsQueried: 1,
    }));
  });

  test.each([
    { pipe: 'unknown' },
    { timeRange: 'unknown' },
    { scope: 'unknown' },
  ])('rejects invalid query parameters through the route: %p', async (query) => {
    const { status, body } = await request('POST', '/api/fe97a788/query', query);

    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe('QUERY_PARAMS_INVALID');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns pipe, time-range, and scope metadata', async () => {
    const { status, body } = await request('GET', '/api/fe97a788/pipes');

    expect(status).toBe(200);
    expect(body.pipes).toEqual(Object.entries(PIPES).map(([key, pipe]) => ({
      key,
      label: pipe.label,
      datasource: pipe.datasource,
      dimension: pipe.dimension,
      endpoint: `/v0/pipes/${key}.json`,
    })));
    expect(body.timeRanges).toEqual(Object.entries(TIME_RANGES).map(([key, timeRange]) => ({
      key,
      label: timeRange.label,
    })));
    expect(body.scopeOptions).toEqual(Object.entries(SCOPE_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      shardCount: option.shards.length,
    })));
  });
});
