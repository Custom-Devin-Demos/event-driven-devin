const fs = require('fs');
const path = require('path');
const express = require('express');

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { registerAttendee, PASS_CONFIGS } = require('../app/services/verticals/73575564');
const registrationRouter = require('../app/routes/verticals/73575564');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const PAGE = fs.readFileSync(path.join(__dirname, '../app/public/verticals/73575564.html'), 'utf8');

describe('event registration (73575564)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('a full-day request fails with a TypeError and raises one registration alert', async () => {
    await expect(registerAttendee({ passId: 'full-day', attendeeName: '山田 太郎' })).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({
      route: '/api/73575564/register',
      service: 'event-registration-api',
      alert_path: 'instant',
    });

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.verticalLabel).toBe('イベント参加申込（Merge Tokyo 2026）');
    expect(alert.locale).toBe('ja');
    expect(alert.service).toBe('event-registration-api');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('app/services/verticals/73575564.js');
    expect(alert.culprit).not.toContain('hightech');
    expect(isInstantPathEvent(alert)).toBe(true);
  });

  test.each(['keynote', 'sessions'])('a %s request is queued for approval without an alert', async (passId) => {
    const result = await registerAttendee({ passId, attendeeName: '山田 太郎' });
    expect(result).toMatchObject({ success: true, passId, status: 'pending-approval' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('the Sentry webhook treats the registration failure as already alerted', () => {
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/73575564.js — registerAttendee', tags: [] })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'processImmediate(node:internal/timers)', tags: [{ key: 'alert_path', value: 'instant' }] })).toBe(true);
  });

  describe('routes', () => {
    let server;
    let base;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      app.use(registrationRouter);
      await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
      base = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll((done) => { server.close(done); });

    test('POST /api/73575564/register returns the registration failure, not a provisioning one', async () => {
      const res = await fetch(`${base}/api/73575564/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passId: 'full-day', attendeeName: '山田 太郎' }),
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.errorClass).toBe('TypeError');
      expect(body.code).toBe('REGISTRATION_FAILED');
    });

    test('POST /api/73575564/register accepts a keynote-only request', async () => {
      const res = await fetch(`${base}/api/73575564/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passId: 'keynote' }),
      });
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.passLabel).toBe('基調講演のみ');
    });

    test('GET /api/73575564/event lists the event and its passes', async () => {
      const res = await fetch(`${base}/api/73575564/event`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.event.id).toBe('merge-tokyo-2026');
      expect(body.passes.map((p) => p.id).sort()).toEqual(Object.keys(PASS_CONFIGS).sort());
    });
  });

  describe('page', () => {
    test('submits to the registration API when bare and to the provisioning API under the on-call shim', () => {
      expect(PAGE).toContain("var shimmed = !!document.getElementById('oncall-unique');");
      expect(PAGE).toContain("shimmed ? '/api/licenses/provision' : '/api/73575564/register'");
      expect(PAGE).toContain('passId: pass,');
      expect(PAGE).not.toContain("fetch('/api/licenses/provision'");
    });

    test('a slow submit under the shim ends in a visible timeout error', () => {
      expect(PAGE).toContain('REGISTER_TIMEOUT_MS = 5000');
      expect(PAGE).toContain('HTTP 504 Gateway Timeout');
      expect(PAGE).toContain('<title>Merge Tokyo 2026</title>');
    });
  });
});

describe('on-call latency track (73575564)', () => {
  const { getOncallSkin } = require('../config/oncall-skins');
  const { ALERT_SCENARIOS, buildOncallSessionPrompt } = require('../app/services/oncall');

  test('Devin prompt carries the registration labels and answers in Japanese', () => {
    const skin = getOncallSkin('73575564');
    expect(skin).toMatchObject({ vertical: 'hightech', locale: 'ja' });
    expect(skin.page.title).toBe('Merge Tokyo 2026');
    expect(skin.alertDestination).toBeUndefined();
    const prompt = buildOncallSessionPrompt(ALERT_SCENARIOS.hightech, skin, 'ref-1');
    expect(prompt).toContain('p95レイテンシ上昇中 — イベント参加申込（Merge Tokyo 2026）');
    expect(prompt).toContain('event-registration@2.4.0');
    expect(prompt).toContain('日本語で回答してください');
    expect(prompt).toContain('見出しも本文もすべて日本語');
    expect(prompt).toContain('「What I recommend」→「推奨対応」');
    expect(prompt).toContain('POST /api/oncall/licenses/provision');
    expect(prompt).not.toContain('novasoft');
  });
});
