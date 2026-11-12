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

// These tests cover the demo wiring that stays true after the planted IDOR is
// fixed: the signed-in owner can read their own account, auth and input
// validation hold, and the security alert is registered as an instant path so
// the Sentry webhook never double-alerts. The cross-account exposure itself and
// the enumeration alert are the planted vulnerability — the remediation session
// owns proving another player's id returns 403, so this suite deliberately does
// not assert the leak as a contract.

const flush = () => new Promise((resolve) => setImmediate(resolve));
const OWNER = logs.OWNER_ACCOUNT;
const SESSION = logs.ATTACKER_SESSION;

function thrownBy(fn) {
  try { fn(); } catch (e) { return e; }
  return null;
}

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

  test('the owner reads their own account without raising an alert', async () => {
    const r = service.getProfile({ accountId: OWNER, sessionId: SESSION });
    expect(r.success).toBe(true);
    expect(r.profile.accountId).toBe(OWNER);
    expect(r.profile.email).toContain('@');
    await flush();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a request with no session is rejected with 401', () => {
    const err = thrownBy(() => service.getProfile({ accountId: OWNER, sessionId: '' }));
    expect(err).not.toBeNull();
    expect(err.statusCode).toBe(401);
    expect(err.code).toBe('NOT_AUTHENTICATED');
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

  test('GET /api/accounts/:id/profile returns the owner profile for a valid session', async () => {
    const res = await request(server, `/api/accounts/${OWNER}/profile`, { 'x-ea-session': SESSION });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.profile.accountId).toBe(OWNER);
  });

  test('GET /api/accounts/:id/profile rejects a malformed account id with 400', async () => {
    const res = await request(server, '/api/accounts/not-an-id/profile', { 'x-ea-session': SESSION });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('INVALID_ACCOUNT_ID');
  });

  test('GET /api/accounts/:id/profile returns 401 without a session', async () => {
    const res = await request(server, `/api/accounts/${OWNER}/profile`);
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('NOT_AUTHENTICATED');
  });

  test('GET /api/4491bcfa/session returns the portal bootstrap', async () => {
    const res = await request(server, '/api/4491bcfa/session');
    expect(res.status).toBe(200);
    expect(res.body.me.accountId).toBe(OWNER);
  });
});

describe('EA Account security alert is an instant path (4491bcfa)', () => {
  // The service alerts directly, tagging alert_path=instant; the Sentry webhook
  // must treat both the tagged event and the tagless issue webhook (which can
  // only match on the culprit) as already-alerted so it never double-alerts.
  const culprit = 'app/services/verticals/4491bcfa.js — getProfile';
  const errorType = 'BrokenObjectLevelAuthorization';

  test('a tagged instant event is recognised', () => {
    expect(isInstantPathEvent({
      issueTitle: 'SEC-HIGH: Possible account enumeration on /api/accounts/*/profile.',
      errorType,
      culprit,
      tags: [{ key: 'alert_path', value: 'instant' }],
    })).toBe(true);
  });

  test('a tagless issue webhook is recognised by its culprit', () => {
    expect(isInstantPathEvent({
      issueTitle: 'SEC-HIGH: Possible account enumeration on /api/accounts/*/profile.',
      errorType,
      culprit,
    })).toBe(true);
  });
});
