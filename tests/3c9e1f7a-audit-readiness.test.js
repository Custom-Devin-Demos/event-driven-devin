/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/logger', () => ({
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
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
const {
  runAuditReadiness,
  ASSET_CLASSES,
  ALL_ASSET_CLASSES,
  SCOPE_OPTIONS,
  SITES,
  RECORD_FETCH_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/3c9e1f7a');
const routes = require('../app/routes/verticals/3c9e1f7a');

const ORIGINAL_LATENCY = [...RECORD_FETCH_POLICY.latencyMs];
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
        host: '127.0.0.1',
        port,
        path,
        method,
        headers,
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
  RECORD_FETCH_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

describe('Blue Mountain RAM audit readiness', () => {
  test('checks all 14 asset classes in order and summarizes the State College fixture', async () => {
    RECORD_FETCH_POLICY.latencyMs = [0, 0];

    const result = await runAuditReadiness({});
    const records = Object.entries(SITES.state_college.records);
    const expected = records.reduce((summary, [, record]) => ({
      totalAssets: summary.totalAssets + record.assets,
      dueSoon: summary.dueSoon + record.dueSoon,
      overdue: summary.overdue + record.overdue,
      outOfTolerance: summary.outOfTolerance + record.outOfTolerance,
    }), {
      totalAssets: 0,
      dueSoon: 0,
      overdue: 0,
      outOfTolerance: 0,
    });

    expect(result.success).toBe(true);
    expect(result.checkId).toMatch(/^RAM-[0-9A-F]{8}$/);
    expect(result.site).toEqual({ key: 'state_college', label: 'State College, PA' });
    expect(result.scope).toEqual({ key: 'all', label: 'All GMP asset classes' });
    expect(result.classesChecked).toBe(14);
    expect(result.results.map((record) => record.key)).toEqual(ALL_ASSET_CLASSES);
    expect(result.results.map((record) => record.label)).toEqual(
      ALL_ASSET_CLASSES.map((key) => ASSET_CLASSES[key].label),
    );
    expect(result.summary).toEqual({
      ...expected,
      inTolerancePct: Number((((expected.totalAssets - expected.outOfTolerance) / expected.totalAssets) * 100).toFixed(1)),
      compliantClasses: 12,
      needsAttentionClasses: 2,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('loads a single asset class through the fast path', async () => {
    RECORD_FETCH_POLICY.latencyMs = [1, 2];

    const result = await runAuditReadiness({ scope: 'pipettes' });

    expect(result.success).toBe(true);
    expect(result.scope).toEqual({ key: 'pipettes', label: 'Pipettes' });
    expect(result.classesChecked).toBe(1);
    expect(result.results.map((record) => record.key)).toEqual(['pipettes']);
    expect(result.durationMs).toBeLessThan(1000);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    { site: 'not-a-site' },
    { scope: 'not-an-asset-class' },
  ])('rejects invalid audit request %p through the route', async (body) => {
    const { status, body: response } = await request(
      'POST',
      '/api/3c9e1f7a/audit-readiness',
      body,
    );

    expect(status).toBe(400);
    expect(response.success).toBe(false);
    expect(response.errorClass).toBe('ValidationError');
    expect(response.code).toBe('AUDIT_READINESS_INVALID');
    expect(response).toHaveProperty('requestId');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('schedules a latency-budget alert while returning the successful audit result', async () => {
    RECORD_FETCH_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/3c9e1f7a/audit-readiness', {
      site: 'state_college',
      scope: 'pipettes',
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
    expect(alert.customer).toBe('3c9e1f7a');
    expect(alert.service).toBe('customer-3c9e1f7a-audit-readiness');
    expect(alert.culprit).toBe('app/services/verticals/3c9e1f7a.js — loadAssetClassRecords');
    expect(alert.verticalLabel).toBe('Blue Mountain RAM Audit Readiness');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('jordan.lee@example.com');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/3c9e1f7a/audit-readiness' },
      { key: 'scope', value: 'pipettes' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1]).toEqual(expect.objectContaining({
      level: 'warning',
      tags: expect.objectContaining({
        alert_path: 'latency',
        route: '/api/3c9e1f7a/audit-readiness',
      }),
    }));
  });

  test('returns scope metadata and asset class options', async () => {
    const { status, body } = await request('GET', '/api/3c9e1f7a/options');

    expect(status).toBe(200);
    expect(body.sites.map((site) => site.key)).toEqual(Object.keys(SITES));
    expect(body.scopeOptions[0]).toEqual({
      key: 'all',
      label: 'All GMP asset classes',
      classCount: 14,
    });
    expect(body.scopeOptions).toHaveLength(Object.keys(SCOPE_OPTIONS).length);
    expect(body.assetClasses).toHaveLength(14);
  });
});
