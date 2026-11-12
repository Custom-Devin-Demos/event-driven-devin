/* global describe, expect, test, jest, beforeEach, afterEach, setImmediate */

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

const { createSessionAndAlert } = require('../app/services/devin-session');
const service = require('../app/services/verticals/4491bcfa');
const logs = require('../app/services/verticals/4491bcfa-logs');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const verticalRoute = require('../app/routes/verticals/4491bcfa');

const flush = () => new Promise((resolve) => setImmediate(resolve));
const OWNER = logs.OWNER_ACCOUNT;
const SESSION = logs.ATTACKER_SESSION;

function request(server, path, headers) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ port, path, headers: headers || {} }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: body ? JSON.parse(body) : null }));
    }).on('error', reject);
  });
}

beforeEach(() => {
  service._resetEnumeration();
  jest.clearAllMocks();
});

describe('EA Account portal service (4491bcfa)', () => {
  test('exposes the signed-in portal session and owner', () => {
    const boot = service.getPortalSession();
    expect(boot.success).toBe(true);
    expect(boot.session.sessionId).toBe(SESSION);
    expect(boot.me.accountId).toBe(OWNER);
  });

  test('returns the owner profile without raising an alert', async () => {
    const r = service.getProfile({ accountId: OWNER, sessionId: SESSION });
    expect(r.success).toBe(true);
    expect(r.profile.accountId).toBe(OWNER);
    expect(r.profile.email).toContain('@');
    await flush();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('requires a valid session (401) and a known account (404)', () => {
    expect(() => service.getProfile({ accountId: OWNER, sessionId: '' })).toThrow();
    try { service.getProfile({ accountId: OWNER, sessionId: '' }); } catch (e) { expect(e.statusCode).toBe(401); }
    try { service.getProfile({ accountId: 'EA-999999', sessionId: SESSION }); } catch (e) { expect(e.statusCode).toBe(404); }
  });

  test('crossing the enumeration threshold raises exactly one SEC-HIGH alert', async () => {
    // 213 distinct cross-account ids are already seeded for this session; a new one crosses 214.
    const fresh = 'EA-100250';
    expect(logs.SEEDED_IDS).not.toContain(fresh);
    const r = service.getProfile({ accountId: fresh, sessionId: SESSION });
    expect(r.success).toBe(true);
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('4491bcfa');
    expect(alert.issueTitle).toMatch(/^SEC-HIGH: Possible account enumeration/);
    expect(alert.issueTitle).toContain('214 distinct account IDs');
    expect(alert.errorType).toBe('BrokenObjectLevelAuthorization');
    expect(alert.promptAppendix).toContain('CWE-639');

    // A second cross-account read does not fire a duplicate session.
    service.getProfile({ accountId: 'EA-100251', sessionId: SESSION });
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('the security alert is registered as an instant path (no duplicate webhook alert)', async () => {
    service.getProfile({ accountId: 'EA-100250', sessionId: SESSION });
    await flush();
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(isInstantPathEvent({
      issueTitle: alert.issueTitle,
      errorType: alert.errorType,
      tags: alert.tags,
      culprit: alert.culprit,
    })).toBe(true);
  });
});

describe('EA Account portal routes (4491bcfa)', () => {
  let server;
  beforeEach((done) => {
    const app = express();
    app.use(express.json());
    app.use(verticalRoute);
    server = http.createServer(app);
    server.listen(0, () => done());
  });
  afterEach((done) => { server.close(() => done()); });

  test('GET /api/accounts/:id/profile returns a profile for a valid session', async () => {
    const res = await request(server, `/api/accounts/${OWNER}/profile`, { 'x-ea-session': SESSION });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.profile.accountId).toBe(OWNER);
  });

  test('GET /api/accounts/:id/profile rejects a malformed account id with 400', async () => {
    const res = await request(server, '/api/accounts/not-an-id/profile', { 'x-ea-session': SESSION });
    expect(res.status).toBe(400);
  });

  test('GET /api/4491bcfa/session returns the portal bootstrap', async () => {
    const res = await request(server, '/api/4491bcfa/session');
    expect(res.status).toBe(200);
    expect(res.body.me.accountId).toBe(OWNER);
  });
});
