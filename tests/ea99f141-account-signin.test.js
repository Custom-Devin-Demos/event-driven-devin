/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const routes = require('../app/routes/verticals/ea99f141');
const { ROUTE } = require('../app/services/verticals/ea99f141');

function post(body) {
  const app = express();
  app.use(express.json());
  app.use(routes);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: ROUTE,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => { server.close(); resolve({ status: res.statusCode, body: JSON.parse(raw) }); });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.end(payload);
    });
  });
}

describe('ea99f141 hero Sign in', () => {
  afterEach(() => jest.clearAllMocks());

  test('the page is direct-URL only and wires the hero Sign in link', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/ea99f141.html'), 'utf8');
    expect(html).toContain('id="internet-hero-sign-in"');
    expect(html).toContain("fetch('/api/ea99f141/account-sessions'");
    const hub = fs.readFileSync(path.join(__dirname, '../app/public/hub.html'), 'utf8');
    expect(hub).not.toContain('ea99f141');
  });

  test('sign-in fails with HTTP 500 and raises an instant alert', async () => {
    const res = await post({ entryPoint: 'internet-hero', devinOrgId: 'org-abc123', devinUserId: 'user-1' });
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, errorClass: 'TypeError', code: 'ACCOUNT_SIGNIN_FAILED' });
    expect(res.body.requestId).toBeTruthy();
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'ea99f141', devinOrgId: 'org-abc123', devinUserId: 'user-1',
    }));
  });

  test('a malformed org id is dropped', async () => {
    await post({ devinOrgId: 'not an org' });
    expect(createSessionAndAlert.mock.calls[0][0].devinOrgId).toBeUndefined();
  });

  test('alerts take the instant path', () => {
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/ea99f141.js', tags: [] })).toBe(true);
  });
});
