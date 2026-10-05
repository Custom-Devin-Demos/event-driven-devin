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
const { registerAttendee, SLOT_CONFIGS } = require('../app/services/verticals/4875267e');
const registrationRouter = require('../app/routes/verticals/4875267e');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const PAGE = fs.readFileSync(path.join(__dirname, '../app/public/verticals/4875267e.html'), 'utf8');

describe('event registration (4875267e)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('registering for a slot fails with a TypeError and raises one Event Registration alert', async () => {
    await expect(registerAttendee({ slotId: 'general', displayName: 'tanaka_m' })).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({
      route: '/api/4875267e/register',
      service: 'event-registration-api',
      alert_path: 'instant',
    });

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.verticalLabel).toBe('Event Registration');
    expect(alert.service).toBe('event-registration-api');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('app/services/verticals/4875267e.js');
    expect(alert.culprit).not.toContain('hightech');
  });

  test('the Sentry webhook treats the registration failure as already alerted', () => {
    const alert = createSessionAndAlert.mock.calls[0] ? createSessionAndAlert.mock.calls[0][0] : null;
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/4875267e.js — registerAttendee', tags: [] })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'processImmediate(node:internal/timers)', tags: [{ key: 'alert_path', value: 'instant' }] })).toBe(true);
    if (alert) expect(isInstantPathEvent(alert)).toBe(true);
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

    afterAll(() => new Promise((resolve) => server.close(resolve)));

    test('POST /api/4875267e/register returns the registration failure, not a provisioning one', async () => {
      const res = await fetch(`${base}/api/4875267e/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ slotId: 'general', displayName: 'tanaka_m', experience: 'starter', referral: 'manabiba' }),
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.errorClass).toBe('TypeError');
      expect(body.code).toBe('REGISTRATION_FAILED');
    });

    test('GET /api/4875267e/event lists the event and its slots', async () => {
      const res = await fetch(`${base}/api/4875267e/event`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.event.id).toBe('fukuoka-go-27');
      expect(body.slots.map((s) => s.id).sort()).toEqual(Object.keys(SLOT_CONFIGS).sort());
    });
  });

  describe('page', () => {
    test('submits to the event-registration API when bare and to the provisioning API under the on-call shim', () => {
      expect(PAGE).toContain("var shimmed = !!document.getElementById('oncall-unique');");
      expect(PAGE).toContain("shimmed ? '/api/licenses/provision' : '/api/4875267e/register'");
      expect(PAGE).toContain('slotId: slot,');
      expect(PAGE).not.toContain("fetch('/api/licenses/provision'");
    });
  });
});
