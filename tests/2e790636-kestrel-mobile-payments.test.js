jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
}));
jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 's-kestrel', url: 'https://app.devin.ai/sessions/s-kestrel' }),
}));
jest.mock('../app/telemetry/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureMessage: jest.fn(), captureException: jest.fn() } }));
jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn(), recordMetric: jest.fn(), recordTiming: jest.fn() }));

const express = require('express');
const http = require('http');
const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const kestrel = require('../app/services/oncall-verticals/kestrel-mobile');
const bankingVertical = require('../app/services/oncall-verticals/banking');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const PAYMENT = { fromAccount: '41827365', payeeId: 'priya-shah', amountMinor: 2500, currency: 'GBP', reference: 'Dinner' };

function virtualClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms) => { t += ms; } };
}

describe('Kestrel mobile payments API (2e790636)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    kestrel.resetIncidentsForTests();
  });

  test('validates the seeded payment and rejects anything else', () => {
    expect(kestrel.validatePayment(PAYMENT)).toMatchObject({ amountMinor: 2500, reference: 'Dinner' });
    expect(kestrel.validatePayment({ ...PAYMENT, payeeId: 'someone' })).toBeNull();
    expect(kestrel.validatePayment({ ...PAYMENT, currency: 'USD' })).toBeNull();
    expect(kestrel.validatePayment({ ...PAYMENT, amountMinor: 0 })).toBeNull();
  });

  test('the 90-day AML window holds 36 transactions, each 180-320 ms', () => {
    const window = kestrel.amlWindow();
    expect(window).toHaveLength(36);
    window.forEach((txn) => {
      expect(txn.screeningMs).toBeGreaterThanOrEqual(180);
      expect(txn.screeningMs).toBeLessThanOrEqual(320);
      expect(txn.daysAgo).toBeLessThan(kestrel.PAYMENT_CONFIG.amlWindowDays);
    });
  });

  test('screens every transaction exactly once and keeps the 5 s hold', async () => {
    const clock = virtualClock();
    const result = await kestrel.makePayment(kestrel.validatePayment(PAYMENT), clock);
    expect(result.screeningCount).toBe(36);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('HOLD_EXPIRED');
    expect(result.durationMs).toBeGreaterThan(kestrel.PAYMENT_CONFIG.authHoldTtlMs);
    expect(result.spans.find((s) => s.name === 'payments.aml_screen').count).toBe(36);
    expect(kestrel.PAYMENT_CONFIG.authHoldTtlMs).toBe(5000);
  });

  test('rejects inherited object keys as payees', () => {
    ['__proto__', 'constructor', 'toString'].forEach((payeeId) => {
      expect(kestrel.validatePayment({ ...PAYMENT, payeeId })).toBeNull();
    });
  });

  test('stays separate from the shared banking vertical config', () => {
    expect(kestrel.PAYMENT_CONFIG).not.toBe(bankingVertical.COMPLIANCE_CONFIG);
  });

  test('alert names both platforms and the prompt asks for iOS + Android testing sub-sessions', () => {
    const result = { durationMs: 9342, screeningConcurrency: 1, spans: [{ name: 'payments.aml_screen', count: 36, totalMs: 8922 }] };
    const ctx = { reference: 'KB-abc123', platform: 'android', release: 'kestrel-mobile@1.0', now: new Date(0) };
    const alert = kestrel.buildAlertMessage(result, ctx);
    expect(alert).toContain('iOS and Android');
    expect(alert).toContain('HTTP 504 HOLD_EXPIRED after 9,342 ms');
    const prompt = kestrel.buildSessionPrompt(result, ctx);
    expect(prompt).toContain('*macOS* child');
    expect(prompt).toContain('*Linux* child');
    expect(prompt).toContain('BEFORE — backend main');
    expect(prompt).toContain('recording_start');
    expect(prompt).toContain('REGRESSION — fix branch');
    expect(prompt).toContain('Do NOT merge');
  });

  test('one incident per cooldown window even when both apps fail', async () => {
    const result = { durationMs: 9342, screeningConcurrency: 1, spans: [] };
    const first = kestrel.raiseIncident(result, { platform: 'ios', release: 'kestrel-mobile@1.0', nowMs: 1000 });
    await first.outcome;
    const second = kestrel.raiseIncident(result, { platform: 'android', release: 'kestrel-mobile@1.0', nowMs: 5000 });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.incident.reference).toBe(first.incident.reference);
    expect([...second.incident.platforms]).toEqual(['ios', 'android']);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(createDevinSession.mock.calls[0][1]).toMatchObject({ platform: 'linux', repos: kestrel.KESTREL.repos });
  });

  describe('route', () => {
    let server;
    let base;
    beforeAll(async () => {
      jest.spyOn(kestrel, 'makePayment').mockResolvedValue({
        ok: false, error: 'HOLD_EXPIRED', durationMs: 9342, screeningCount: 36, screeningConcurrency: 1, spans: [],
      });
      const app = express();
      app.use(express.json());
      app.use(require('../app/routes/oncall'));
      server = http.createServer(app);
      await new Promise((r) => server.listen(0, r));
      base = `http://127.0.0.1:${server.address().port}/api/oncall/2e790636/mobile/payments`;
    });
    afterAll(async () => {
      await new Promise((r) => server.close(r));
    });
    const post = (headers, body = PAYMENT) => fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

    test('failed payment returns 504 with the calm message and no alert when alerts are off', async () => {
      const res = await post({ 'x-client-platform': 'ios' });
      expect(res.status).toBe(504);
      const json = await res.json();
      expect(json).toMatchObject({ status: 'failed', error: 'HOLD_EXPIRED', message: kestrel.CALM_ERROR, reference: null });
      expect(postMessage).not.toHaveBeenCalled();
    });

    test('alerts on raises one incident with a reference', async () => {
      const res = await post({ 'x-client-platform': 'android', 'x-demo-alerts': 'on' });
      const json = await res.json();
      expect(json.reference).toMatch(/^KB-[0-9a-f]{6}$/);
    });

    test('rejects an unknown payee', async () => {
      const res = await post({}, { ...PAYMENT, payeeId: 'x' });
      expect(res.status).toBe(400);
    });
  });
});
