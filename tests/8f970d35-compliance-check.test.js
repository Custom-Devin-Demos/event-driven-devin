/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/8f970d35');
const {
  runComplianceCheck,
  FRAMEWORKS,
  ALL_FRAMEWORKS,
  SCOPE_OPTIONS,
  FRAMEWORK_CHECK_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/8f970d35');

const ORIGINAL_LATENCY = [...FRAMEWORK_CHECK_POLICY.latencyMs];
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
  FRAMEWORK_CHECK_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Diligent compliance check', () => {
  test('checks every framework in order for the default "All frameworks" scope', async () => {
    FRAMEWORK_CHECK_POLICY.latencyMs = [1, 3];

    const result = await runComplianceCheck({ organization: 'Northwind Holdings plc' });

    expect(result.success).toBe(true);
    expect(result.checkId).toMatch(/^DIL-[0-9A-F]{8}$/);
    expect(result.organization).toBe('Northwind Holdings plc');
    expect(result.scope).toEqual({ key: 'all', label: 'All frameworks' });
    expect(result.frameworksChecked).toBe(14);
    expect(result.results.map((r) => r.framework)).toEqual(ALL_FRAMEWORKS);

    for (const r of result.results) {
      expect(r.label).toBe(FRAMEWORKS[r.framework].label);
      expect(r.controlsTested).toBe(FRAMEWORKS[r.framework].controls);
      expect(r.controlsPassed + r.exceptions).toBe(r.controlsTested);
      expect(r.exceptions).toBeGreaterThanOrEqual(0);
      expect(r.status === 'compliant').toBe(r.exceptions === 0);
    }

    const { summary } = result;
    expect(summary.frameworksChecked).toBe(14);
    expect(summary.compliant + summary.needsAttention + summary.atRisk).toBe(14);
    expect(summary.controlsTested).toBe(ALL_FRAMEWORKS.reduce((s, k) => s + FRAMEWORKS[k].controls, 0));
    expect(summary.controlsPassed + summary.exceptions).toBe(summary.controlsTested);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns deterministic results for the same organization', async () => {
    FRAMEWORK_CHECK_POLICY.latencyMs = [1, 2];

    const a = await runComplianceCheck({ organization: 'Acme Corp' });
    const b = await runComplianceCheck({ organization: 'Acme Corp' });

    expect(a.results).toEqual(b.results);
    expect(a.summary).toEqual(b.summary);
  });

  test.each(['gdpr', 'sox', 'dora'])('checks a single framework for scope %p', async (scope) => {
    FRAMEWORK_CHECK_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/8f970d35/compliance-check', {
      organization: 'Northwind Holdings plc',
      scope,
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scope).toEqual({ key: scope, label: FRAMEWORKS[scope].label });
    expect(body.frameworksChecked).toBe(1);
    expect(body.results.map((r) => r.framework)).toEqual([scope]);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('single-framework results match the same framework in the full check', async () => {
    FRAMEWORK_CHECK_POLICY.latencyMs = [1, 2];

    const full = await runComplianceCheck({ organization: 'Contoso Group' });
    const single = await runComplianceCheck({ organization: 'Contoso Group', scope: 'pcidss' });

    expect(single.results[0]).toEqual(full.results.find((r) => r.framework === 'pcidss'));
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    FRAMEWORK_CHECK_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/8f970d35/compliance-check', {
      organization: 'Northwind Holdings plc',
      scope: 'gdpr',
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
    expect(alert.issueTitle).toContain('POST /api/8f970d35/compliance-check took');
    expect(alert.customer).toBe('8f970d35');
    expect(alert.service).toBe('customer-8f970d35-compliance-check');
    expect(alert.culprit).toBe('app/services/verticals/8f970d35.js — runFrameworkChecks');
    expect(alert.verticalLabel).toBe('Diligent One Compliance Check');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('jordan.lee@example.com');
    expect(alert.promptAppendix).toContain('runFrameworkChecks');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/8f970d35/compliance-check' },
      { key: 'service', value: 'customer-8f970d35-compliance-check' },
      { key: 'scope', value: 'gdpr' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.checkId,
      durationMs: body.durationMs,
      budgetMs: 1,
      frameworksChecked: 1,
    }));
  });

  test('rejects invalid check requests through the route', async () => {
    const invalidRequests = [
      { organization: '' },
      { organization: 'x' },
      { organization: 'a'.repeat(121) },
      { organization: 'Northwind Holdings plc', scope: 'not-a-framework' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request(
        'POST',
        '/api/8f970d35/compliance-check',
        body,
      );
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('COMPLIANCE_CHECK_INVALID');
      expect(response).toHaveProperty('requestId');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns framework and scope metadata', async () => {
    const { status, body } = await request('GET', '/api/8f970d35/frameworks');

    expect(status).toBe(200);
    expect(body.frameworks.map((f) => f.key)).toEqual(ALL_FRAMEWORKS);
    expect(body.scopeOptions[0]).toEqual({ key: 'all', label: 'All frameworks', frameworkCount: 14 });
    expect(body.scopeOptions).toHaveLength(Object.keys(SCOPE_OPTIONS).length);
  });
});
