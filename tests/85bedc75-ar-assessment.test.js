/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/85bedc75');
const {
  runRevenueCycleAssessment,
  PAYERS,
  SCOPE_OPTIONS,
  FACILITY_TYPES,
  PAYER_FEED_POLICY,
  LATENCY_SLO,
  REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/85bedc75');

const ORIGINAL_LATENCY = [...PAYER_FEED_POLICY.latencyMs];
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
  PAYER_FEED_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Conifer Health revenue cycle assessment', () => {
  test('default assessment covers every contracted payer in order with consistent summary math', async () => {
    PAYER_FEED_POLICY.latencyMs = [1, 3];

    const result = await runRevenueCycleAssessment();
    const { summary, payerResults } = result;

    expect(result.success).toBe(true);
    expect(result.assessmentId).toMatch(/^CHS-[0-9A-F]{8}$/);
    expect(result.organization).toBe('Dartmouth Health');
    expect(result.facilityType).toEqual({ key: 'hospital', label: 'Hospital & Health System' });
    expect(result.annualNprMillions).toBe(850);
    expect(result.scope).toEqual({ key: 'all', label: 'All contracted payers' });
    expect(payerResults.map((r) => r.payer)).toEqual(Object.keys(PAYERS));
    expect(summary.payersAssessed).toBe(14);
    expect(summary.totalClaims).toBe(payerResults.reduce((s, r) => s + r.claims, 0));
    expect(summary.deniedClaims).toBe(payerResults.reduce((s, r) => s + r.deniedClaims, 0));
    expect(summary.openArCents).toBe(payerResults.reduce((s, r) => s + r.openArCents, 0));
    expect(summary.recoverableCents).toBe(payerResults.reduce((s, r) => s + r.recoverableCents, 0));
    expect(summary.weightedArDays).toBeGreaterThan(result.benchmarkArDays);
    expect(summary.projectedArDays).toBe(result.benchmarkArDays);
    expect(summary.cashAccelerationCents).toBeGreaterThan(0);
    expect(Object.values(PAYERS).reduce((s, p) => s + p.mixPct, 0)).toBe(100);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each(['medicare_a', 'unitedhealthcare', 'bcbstx', 'self_pay'])('single-payer scope %s polls exactly one feed', async (scope) => {
    PAYER_FEED_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/85bedc75/ar-assessment', { scope });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scope.key).toBe(scope);
    expect(body.summary.payersAssessed).toBe(1);
    expect(body.payerResults.map((r) => r.payer)).toEqual(SCOPE_OPTIONS[scope].payers);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('payer results are deterministic for the same inputs', async () => {
    PAYER_FEED_POLICY.latencyMs = [1, 3];

    const a = await runRevenueCycleAssessment({ facilityType: 'physician', annualNprMillions: 120 });
    const b = await runRevenueCycleAssessment({ facilityType: 'physician', annualNprMillions: 120 });

    expect(a.payerResults).toEqual(b.payerResults);
    expect(a.summary).toEqual(b.summary);
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    PAYER_FEED_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/85bedc75/ar-assessment', {
      scope: 'unitedhealthcare',
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
    expect(alert.issueTitle).toBe(`LatencyBudgetExceeded: POST /api/85bedc75/ar-assessment took ${body.durationMs}ms (budget 1ms)`);
    expect(alert.customer).toBe('85bedc75');
    expect(alert.service).toBe('customer-85bedc75-ar-assessment');
    expect(alert.culprit).toBe('app/services/verticals/85bedc75.js — collectPayerRemittances');
    expect(alert.verticalLabel).toBe('Conifer Health Revenue Cycle Assessment');
    expect(alert.promptAppendix).toBe(REMEDIATION_DIRECTIVE);
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/85bedc75/ar-assessment' },
      { key: 'service', value: 'customer-85bedc75-ar-assessment' },
      { key: 'scope', value: 'unitedhealthcare' },
      { key: 'facility_type', value: 'hospital' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.assessmentId,
      durationMs: body.durationMs,
      budgetMs: 1,
      payersPolled: 1,
    }));
  });

  test('rejects invalid assessment details through the route', async () => {
    const invalidRequests = [
      { organization: '' },
      { facilityType: 'pharmacy' },
      { annualNprMillions: 0 },
      { annualNprMillions: 12.5 },
      { scope: 'invalid' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request('POST', '/api/85bedc75/ar-assessment', body);
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('ASSESSMENT_DETAILS_INVALID');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns payer, scope and facility metadata', async () => {
    const { status, body } = await request('GET', '/api/85bedc75/payers');

    expect(status).toBe(200);
    expect(body.payers).toHaveLength(14);
    expect(body.scopeOptions).toEqual(Object.entries(SCOPE_OPTIONS).map(([key, option]) => ({
      key,
      label: option.label,
      payerCount: option.payers.length,
    })));
    expect(body.facilityTypes.map((f) => f.key)).toEqual(Object.keys(FACILITY_TYPES));
  });
});
