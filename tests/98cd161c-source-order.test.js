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
const routes = require('../app/routes/verticals/98cd161c');
const {
  runSourceOrder,
  NETWORK_MEMBERS,
  SOURCE_SCOPES,
  LATENCY_SLO,
  MEMBER_QUOTE_POLICY,
  NETWORK_RATE_PCT,
} = require('../app/services/verticals/98cd161c');

const ORIGINAL_LATENCY = [...MEMBER_QUOTE_POLICY.latencyMs];
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
  MEMBER_QUOTE_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
  incrementMetric.mockClear();
  recordTiming.mockClear();
});

describe('ModernFi Source Deposits source order', () => {
  test('allocates the default $50M source order across all network members in order', async () => {
    MEMBER_QUOTE_POLICY.latencyMs = [1, 3];

    const result = await runSourceOrder({
      institution: 'Community Bank',
      targetBalance: 50000000,
    });

    expect(result.success).toBe(true);
    expect(result.requestId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.institution).toBe('Community Bank');
    expect(result.scope).toBe('all');
    expect(result.scopeLabel).toBe('All network members (14)');
    expect(result.targetBalanceCents).toBe(5000000000);
    expect(result.networkRatePct).toBe(NETWORK_RATE_PCT);
    expect(result.allocations).toHaveLength(14);
    expect(result.allocations.map((allocation) => allocation.member)).toEqual(Object.keys(NETWORK_MEMBERS));

    for (const allocation of result.allocations) {
      const member = NETWORK_MEMBERS[allocation.member];
      expect(allocation.label).toBe(member.label);
      expect(allocation.assetsLabel).toBe(member.assetsLabel);
      expect(allocation.state).toBe(member.state);
      expect(allocation.network).toBe(member.network);
      expect(allocation.offeredCents).toBeGreaterThanOrEqual(Math.round(member.capacityCents * 0.6 / 100000) * 100000);
      expect(allocation.offeredCents).toBeLessThanOrEqual(member.capacityCents);
      expect(allocation.allocatedCents).toBeGreaterThanOrEqual(0);
      expect(allocation.allocatedCents).toBeLessThanOrEqual(allocation.offeredCents);
      expect(['settled', 'standby']).toContain(allocation.status);
    }

    expect(result.summary.membersQuoted).toBe(14);
    expect(result.summary.fundedCents).toBe(5000000000);
    expect(result.summary.fundedPct).toBe(100);
    expect(result.summary.remainingCents).toBe(0);
    expect(result.summary.collateral).toBe('None');
    expect(result.summary.settlementCycle).toBe('Daily');
    expect(result.summary.membersAllocated).toBe(result.allocations.filter((allocation) => allocation.allocatedCents > 0).length);
    expect(result.allocations.reduce((sum, allocation) => sum + allocation.allocatedCents, 0)).toBe(result.summary.fundedCents);
    expect(result.summary.fundedCents).toBeLessThanOrEqual(result.targetBalanceCents);
    expect(result.latencyBudgetMs).toBe(ORIGINAL_BUDGET);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(incrementMetric).toHaveBeenCalledWith('source_order.success', expect.any(Object));
    expect(recordTiming).toHaveBeenCalledWith('source_order.latency', result.latencyMs, expect.any(Object));
  });

  test('returns stable quotes and allocations for the same institution', async () => {
    MEMBER_QUOTE_POLICY.latencyMs = [1, 2];

    const first = await runSourceOrder({ institution: 'North Harbor Bank', targetBalance: 25000000 });
    const second = await runSourceOrder({ institution: 'North Harbor Bank', targetBalance: 25000000 });

    expect(second.allocations).toEqual(first.allocations);
    expect(second.summary).toEqual(first.summary);
  });

  test('returns a single-member allocation through the source-order route', async () => {
    MEMBER_QUOTE_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/98cd161c/source-order', {
      institution: 'Community Bank',
      targetBalance: 50000000,
      scope: 'm03',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.scope).toBe('m03');
    expect(body.scopeLabel).toBe(SOURCE_SCOPES.m03.label);
    expect(body.allocations).toHaveLength(1);
    expect(body.allocations[0].member).toBe('m03');
    expect(body.summary.membersQuoted).toBe(1);
    expect(body.summary.fundedCents).toBe(body.allocations[0].allocatedCents);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns network and scope metadata', async () => {
    const { status, body } = await request('GET', '/api/98cd161c/network');

    expect(status).toBe(200);
    expect(body.networkRatePct).toBe(NETWORK_RATE_PCT);
    expect(body.collateral).toBe('None');
    expect(body.members).toHaveLength(14);
    expect(body.members.map((member) => member.key)).toEqual(Object.keys(NETWORK_MEMBERS));
    expect(body.scopeOptions).toHaveLength(15);
    expect(body.scopeOptions[0]).toEqual({
      key: 'all',
      label: 'All network members (14)',
      memberCount: 14,
    });
  });

  test('rejects invalid source orders through the route', async () => {
    const invalidRequests = [
      { targetBalance: 50000000 },
      { institution: '', targetBalance: 50000000 },
      { institution: 'x'.repeat(81), targetBalance: 50000000 },
      { institution: 'Community Bank', targetBalance: 5 },
      { institution: 'Community Bank', targetBalance: 250000001 },
      { institution: 'Community Bank', targetBalance: '50000000' },
      { institution: 'Community Bank', targetBalance: 1000000.5 },
      { institution: 'Community Bank', targetBalance: 50000000, scope: 'm15' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request('POST', '/api/98cd161c/source-order', body);
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('INVALID_SOURCE_ORDER');
      expect(response.requestId).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('sends a Sentry warning and schedules the Devin alert on a latency breach', async () => {
    MEMBER_QUOTE_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/98cd161c/source-order', {
      institution: 'Community Bank',
      targetBalance: 50000000,
      scope: 'm03',
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
    expect(sentryError.message).toContain('POST /api/98cd161c/source-order took');
    expect(sentryContext).toEqual(expect.objectContaining({
      level: 'warning',
      tags: expect.objectContaining({
        route: '/api/98cd161c/source-order',
        service: 'customer-98cd161c-source-order',
        alert_path: 'latency',
      }),
      extra: expect.objectContaining({
        requestId: body.requestId,
        durationMs: body.latencyMs,
        budgetMs: 1,
        membersQuoted: 1,
      }),
    }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.issueTitle).toContain('POST /api/98cd161c/source-order took');
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.customer).toBe('98cd161c');
    expect(alert.service).toBe('customer-98cd161c-source-order');
    expect(alert.culprit).toBe('app/services/verticals/98cd161c.js — allocateAcrossNetwork');
    expect(alert.verticalLabel).toBe('ModernFi Source Deposits');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('jordan.lee@example.com');
    expect(alert.promptAppendix).toContain('allocateAcrossNetwork');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/98cd161c/source-order' },
      { key: 'service', value: 'customer-98cd161c-source-order' },
      { key: 'scope', value: 'm03' },
      { key: 'duration_ms', value: String(body.latencyMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.requestId,
      durationMs: body.latencyMs,
      budgetMs: 1,
      membersQuoted: 1,
      datadogMetric: 'source_order.latency',
    }));
    expect(incrementMetric).toHaveBeenCalledWith('source_order.latency_budget_breach', expect.any(Object));
  });
});
