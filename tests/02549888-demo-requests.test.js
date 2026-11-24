/* global beforeAll, afterAll, beforeEach, afterEach, describe, expect, jest, test */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const express = require('express');
const router = require('../app/routes/verticals/02549888');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { resetLatencyAlertCooldowns } = require('../app/services/latency-alert-cooldown');
const { PREFILL, OPTIONS, submitDemoRequest } = require('../app/services/verticals/02549888');

describe('Healthie demo request routing', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    createSessionAndAlert.mockReset().mockResolvedValue({ session: {} });
    Sentry.captureException.mockClear();
    resetLatencyAlertCooldowns();
  });

  afterEach(() => jest.useRealTimers());

  async function submit(data = PREFILL, options) {
    const result = submitDemoRequest(data, options);
    await jest.advanceTimersByTimeAsync(7200);
    return result;
  }

  test('default team size goes over budget and reports a sanitized warning', async () => {
    const payload = {
      ...PREFILL,
      devinUserId: 'user_presenter',
      devinOrgId: 'org_presenter',
      devinEmail: 'presenter@example.com',
    };
    expect(await submit(payload)).toMatchObject({
      success: true, budgetExceeded: true, budgetMs: 3000, durationMs: 7000, calendar: 'east', calendarsChecked: 14,
    });
    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'LatencyBudgetExceeded' }),
      expect.objectContaining({ level: 'warning', tags: expect.objectContaining({ alert_path: 'latency' }) }),
    );
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: '02549888', devinUserId: 'user_presenter', devinOrgId: 'org_presenter', devinEmail: 'presenter@example.com',
    }));
    expect(JSON.stringify(createSessionAndAlert.mock.calls)).not.toContain(PREFILL.email);
    expect(JSON.stringify(Sentry.captureException.mock.calls)).not.toContain(PREFILL.email);
  });

  test.each(OPTIONS.teamSize.filter((size) => size !== PREFILL.teamSize))('%s checks one calendar and does not alert', async (teamSize) => {
    expect(await submit({ ...PREFILL, teamSize })).toMatchObject({
      success: true, budgetExceeded: false, durationMs: 500, calendarsChecked: 1,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('rehearsal keeps the delay but does not dispatch', async () => {
    expect(await submit(PREFILL, { rehearsal: true })).toMatchObject({ budgetExceeded: true, durationMs: 7000 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('successful dispatch is deduplicated independently per org', async () => {
    const requests = [
      submitDemoRequest({ ...PREFILL, devinOrgId: 'org_test' }),
      submitDemoRequest({ ...PREFILL, devinOrgId: 'org_test' }),
      submitDemoRequest({ ...PREFILL, devinOrgId: 'org_other' }),
    ];
    await jest.advanceTimersByTimeAsync(7200);
    await Promise.all(requests);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test.each(['no investigation', 'rejection'])('a %s releases the claim for a retry', async (mode) => {
    if (mode === 'rejection') createSessionAndAlert.mockRejectedValueOnce(new Error('dispatch failed'));
    else createSessionAndAlert.mockResolvedValueOnce(null);
    await submit();
    await submit();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });
});

describe('Healthie demo request HTTP routes', () => {
  let server;
  let base;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.close(done);
    server.closeAllConnections();
  });

  test.each(['/healthie/see-a-demo', '/02549888/see-a-demo'])('%s serves the demo form', async (url) => {
    const response = await fetch(base + url);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('See Healthie in action.');
  });

  test('config returns valid prefilled form values', async () => {
    const response = await fetch(`${base}/api/02549888/config`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ prefill: PREFILL, options: OPTIONS, budgetMs: 3000 });
  });

  test.each([
    { firstName: ' ' }, { email: 'wrong' }, { teamSize: 'unknown' }, { techRequirement: '' }, { challenge: 'unknown' },
  ])('invalid data returns 400: %j', async (overrides) => {
    const response = await fetch(`${base}/api/02549888/demo-requests`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...PREFILL, ...overrides }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, code: 'INVALID_DEMO_REQUEST' });
  });
});
