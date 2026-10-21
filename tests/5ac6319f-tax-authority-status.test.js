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
  runTaxAuthorityStatus,
  TAX_AUTHORITIES,
  ALL_AUTHORITIES,
  SCOPE_OPTIONS,
  DOCUMENTS,
  AUTHORITY_POLL_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/5ac6319f');
const routes = require('../app/routes/verticals/5ac6319f');

const ORIGINAL_LATENCY = [...AUTHORITY_POLL_POLICY.latencyMs];
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
  AUTHORITY_POLL_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

describe('Sovos Compliance Network tax authority status', () => {
  test('checks all 14 authorities in order and summarizes the fixture totals', async () => {
    AUTHORITY_POLL_POLICY.latencyMs = [0, 0];

    const result = await runTaxAuthorityStatus({});

    expect(result.success).toBe(true);
    expect(result.checkId).toMatch(/^TAS-[0-9A-F]{8}$/);
    expect(result.scope).toEqual({ key: 'all', label: 'All tax authorities' });
    expect(result.authoritiesChecked).toBe(14);
    expect(result.results.map((authority) => authority.key)).toEqual(ALL_AUTHORITIES);
    expect(result.summary).toEqual({
      documents: 1300,
      cleared: 676,
      pending: 286,
      warnings: 169,
      rejected: 169,
      clearanceRate: 65.0,
      connectedAuthorities: 14,
      authoritiesWithRejections: 14,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('checks a single authority through the fast path', async () => {
    AUTHORITY_POLL_POLICY.latencyMs = [1, 2];

    const result = await runTaxAuthorityStatus({ scope: ' DE_XRECHNUNG ' });

    expect(result.success).toBe(true);
    expect(result.scope).toEqual({
      key: 'de_xrechnung',
      label: 'Germany — ZRE / OZG-RE',
    });
    expect(result.authoritiesChecked).toBe(1);
    expect(result.results.map((authority) => authority.key)).toEqual(['de_xrechnung']);
    expect(result.durationMs).toBeLessThan(1000);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects an invalid scope through the route with a structured response', async () => {
    const { status, body } = await request(
      'POST',
      '/api/5ac6319f/tax-authority-status',
      { scope: 'nope' },
    );

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: 'Select a valid tax authority scope.',
      errorClass: 'ValidationError',
      code: 'TAX_STATUS_INVALID',
      requestId: null,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns the tax authority options and document fixtures', async () => {
    const options = await request('GET', '/api/5ac6319f/options');
    const documents = await request('GET', '/api/5ac6319f/documents');

    expect(options.status).toBe(200);
    expect(options.body.scopeOptions).toEqual(Object.entries(SCOPE_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      authorityCount: option.authorities.length,
    })));
    expect(options.body.authorities).toEqual(ALL_AUTHORITIES.map((key) => ({
      key,
      country: TAX_AUTHORITIES[key].country,
      countryCode: TAX_AUTHORITIES[key].countryCode,
      authority: TAX_AUTHORITIES[key].authority,
      format: TAX_AUTHORITIES[key].format,
      mandate: TAX_AUTHORITIES[key].mandate,
    })));
    expect(documents.status).toBe(200);
    expect(documents.body).toEqual({ documents: DOCUMENTS });
  });

  test('schedules a latency-budget alert while returning the successful status result', async () => {
    AUTHORITY_POLL_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/5ac6319f/tax-authority-status', {
      scope: 'de_xrechnung',
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
    expect(alert.customer).toBe('5ac6319f');
    expect(alert.service).toBe('customer-5ac6319f-tax-authority-status');
    expect(alert.culprit).toBe('app/services/verticals/5ac6319f.js — pollTaxAuthorityStatuses');
    expect(alert.verticalLabel).toBe('Sovos Compliance Network Tax Authority Status');
    expect(alert.promptAppendix).toContain('The culprit is `pollTaxAuthorityStatuses`.');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('jordan.lee@example.com');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/5ac6319f/tax-authority-status' },
      { key: 'scope', value: 'de_xrechnung' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1]).toEqual(expect.objectContaining({
      level: 'warning',
      tags: expect.objectContaining({
        alert_path: 'latency',
        route: '/api/5ac6319f/tax-authority-status',
        service: 'customer-5ac6319f-tax-authority-status',
        scope: 'de_xrechnung',
      }),
    }));
  });

  test('does not alert when the request remains within the latency budget', async () => {
    AUTHORITY_POLL_POLICY.latencyMs = [0, 0];

    const result = await runTaxAuthorityStatus({ scope: 'de_xrechnung' });

    expect(result.success).toBe(true);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
