/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/4ea2d7f6');
const {
  runSurveillanceSweep,
  selectHighestRisk,
  DESKS,
  CHANNEL_SCOPES,
  CONNECTED_CHANNELS,
  LOOKBACK_WINDOWS,
  CHANNEL_CAPTURE_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/4ea2d7f6');

const ORIGINAL_LATENCY = [...CHANNEL_CAPTURE_POLICY.latencyMs];
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
  CHANNEL_CAPTURE_POLICY.latencyMs = [...ORIGINAL_LATENCY];
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Shield surveillance sweep', () => {
  test('sweeps every connected channel in policy order by default', async () => {
    CHANNEL_CAPTURE_POLICY.latencyMs = [1, 3];

    const result = await runSurveillanceSweep();
    const totals = result.captures.reduce((acc, capture) => ({
      messagesCaptured: acc.messagesCaptured + capture.messagesCaptured,
      alertsRaised: acc.alertsRaised + capture.alertsRaised,
      truePositives: acc.truePositives + capture.truePositives,
    }), { messagesCaptured: 0, alertsRaised: 0, truePositives: 0 });

    expect(result.success).toBe(true);
    expect(result.sweepId).toMatch(/^SHD-[0-9A-F]{8}$/);
    expect(result.desk).toEqual({ key: 'rates', label: 'Rates Trading' });
    expect(result.scope).toEqual({ key: 'all', label: 'All connected channels' });
    expect(result.lookback).toEqual({ key: '24h', label: 'Last 24 hours' });
    expect(result.channelsSwept).toBe(14);
    expect(result.captures.map((capture) => capture.channel))
      .toEqual(CONNECTED_CHANNELS.map((channel) => channel.key));
    expect(result.totals).toEqual(totals);
    expect(result.highestRiskChannel).toBe(selectHighestRisk(result.captures).channel);
    result.captures.forEach((capture) => {
      expect(capture.truePositives).toBeLessThanOrEqual(capture.alertsRaised);
      expect(capture.alertsRaised).toBeLessThan(capture.messagesCaptured);
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns identical captures for repeated sweeps', async () => {
    CHANNEL_CAPTURE_POLICY.latencyMs = [1, 3];

    const first = await runSurveillanceSweep({ desk: 'fx', lookback: '7d' });
    const second = await runSurveillanceSweep({ desk: 'fx', lookback: '7d' });

    expect(second.captures).toEqual(first.captures);
  });

  test('breaks highest-risk ties by earliest channel order', () => {
    const captures = [
      { channel: 'first', truePositives: 1, alertsRaised: 4 },
      { channel: 'second', truePositives: 1, alertsRaised: 4 },
      { channel: 'third', truePositives: 0, alertsRaised: 9 },
    ];

    expect(selectHighestRisk(captures).channel).toBe('first');
  });

  test.each(['bloomberg', 'teams', 'whatsapp', 'email'])('sweeps a single channel for the %s scope', async (scope) => {
    CHANNEL_CAPTURE_POLICY.latencyMs = [1, 3];

    const { status, body } = await request('POST', '/api/4ea2d7f6/surveillance-sweep', { scope });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.channelsSwept).toBe(1);
    expect(body.captures.map((capture) => capture.channel)).toEqual([scope]);
    expect(body.highestRiskChannel).toBe(scope);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns a successful response and schedules a latency-budget alert on breach', async () => {
    CHANNEL_CAPTURE_POLICY.latencyMs = [8, 10];
    LATENCY_SLO.budgetMs = 1;

    const { status, body } = await request('POST', '/api/4ea2d7f6/surveillance-sweep', {
      scope: 'teams',
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
    expect(alert.customer).toBe('4ea2d7f6');
    expect(alert.service).toBe('customer-4ea2d7f6-surveillance-sweep');
    expect(alert.culprit).toBe('app/services/verticals/4ea2d7f6.js — collectChannelCaptures');
    expect(alert.verticalLabel).toBe('Shield Communications Surveillance Sweep');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('jordan.lee@example.com');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/4ea2d7f6/surveillance-sweep' },
      { key: 'service', value: 'customer-4ea2d7f6-surveillance-sweep' },
      { key: 'desk', value: 'rates' },
      { key: 'scope', value: 'teams' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.sweepId,
      durationMs: body.durationMs,
      budgetMs: 1,
      channelsSwept: 1,
    }));
  });

  test('rejects invalid sweep parameters through the route', async () => {
    const invalidRequests = [
      { desk: 'crypto' },
      { scope: 'telegram' },
      { lookback: '90d' },
      { desk: '' },
    ];

    for (const body of invalidRequests) {
      const { status, body: response } = await request('POST', '/api/4ea2d7f6/surveillance-sweep', body);
      expect(status).toBe(400);
      expect(response.success).toBe(false);
      expect(response.errorClass).toBe('ValidationError');
      expect(response.code).toBe('SWEEP_PARAMETERS_INVALID');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns desk, scope and lookback metadata', async () => {
    const { status, body } = await request('GET', '/api/4ea2d7f6/options');

    expect(status).toBe(200);
    expect(body.desks).toEqual(Object.entries(DESKS).map(([key, desk]) => ({ key, label: desk.label })));
    expect(body.scopes).toEqual(Object.entries(CHANNEL_SCOPES).map(([key, scope]) => ({
      key,
      label: scope.label,
      channelCount: scope.channels.length,
    })));
    expect(body.lookbacks).toEqual(Object.entries(LOOKBACK_WINDOWS).map(([key, lookback]) => ({ key, label: lookback.label })));
  });
});
