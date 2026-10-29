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
const { submitApplication, FACILITY_CONFIGS } = require('../app/services/verticals/78161f67');
const applicationRouter = require('../app/routes/verticals/78161f67');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const PAGE = fs.readFileSync(path.join(__dirname, '../app/public/verticals/78161f67.html'), 'utf8');

describe('nursery application (78161f67)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('submitting an application fails with a TypeError and raises one e-application alert', async () => {
    await expect(submitApplication({ facilityId: 'chuo', applicantName: 'sato_y' })).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({
      route: '/api/78161f67/apply',
      service: 'e-application-api',
      alert_path: 'instant',
    });

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.verticalLabel).toBe('保育所入所申込（電子申請）');
    expect(alert.locale).toBe('ja');
    expect(alert.service).toBe('e-application-api');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('app/services/verticals/78161f67.js');
    expect(alert.culprit).not.toContain('hightech');
  });

  test('the Sentry webhook treats the application failure as already alerted', () => {
    const alert = createSessionAndAlert.mock.calls[0] ? createSessionAndAlert.mock.calls[0][0] : null;
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/78161f67.js — submitApplication', tags: [] })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'processImmediate(node:internal/timers)', tags: [{ key: 'alert_path', value: 'instant' }] })).toBe(true);
    if (alert) expect(isInstantPathEvent(alert)).toBe(true);
  });

  describe('routes', () => {
    let server;
    let base;

    beforeAll(async () => {
      const app = express();
      app.use(express.json());
      app.use(applicationRouter);
      await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
      base = `http://127.0.0.1:${server.address().port}`;
    });

    afterAll(() => new Promise((resolve) => server.close(resolve)));

    test('POST /api/78161f67/apply returns the application failure, not a provisioning one', async () => {
      const res = await fetch(`${base}/api/78161f67/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ facilityId: 'chuo', applicantName: 'sato_y', ageClass: 'starter', ward: 'chuo' }),
      });
      const body = await res.json();

      expect(res.status).toBe(500);
      expect(body.success).toBe(false);
      expect(body.errorClass).toBe('TypeError');
      expect(body.code).toBe('APPLICATION_FAILED');
    });

    test('GET /api/78161f67/intake lists the intake and its facilities', async () => {
      const res = await fetch(`${base}/api/78161f67/intake`);
      const body = await res.json();
      expect(res.status).toBe(200);
      expect(body.intake.id).toBe('r8-april-nursery-1st');
      expect(body.facilities.map((s) => s.id).sort()).toEqual(Object.keys(FACILITY_CONFIGS).sort());
    });
  });

  describe('page', () => {
    test('submits to the e-application API when bare and to the provisioning API under the on-call shim', () => {
      expect(PAGE).toContain("var shimmed = !!document.getElementById('oncall-unique');");
      expect(PAGE).toContain("shimmed ? '/api/licenses/provision' : '/api/78161f67/apply'");
      expect(PAGE).toContain('facilityId: facility,');
      expect(PAGE).not.toContain("fetch('/api/licenses/provision'");
    });
  });
});
