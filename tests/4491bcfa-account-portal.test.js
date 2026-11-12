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

describe('EA Account enumeration detection (4491bcfa)', () => {
  // Detection is tested through trackEnumeration rather than a cross-account
  // read, so these keep passing once ownership checks reject those reads.
  const session = () => service.resolveSession(SESSION);
  const unseeded = (n) => {
    const id = `EA-1002${n}`;
    expect(logs.SEEDED_IDS).not.toContain(id);
    return id;
  };

  test('the 214th distinct account raises one SEC-HIGH alert', async () => {
    service.trackEnumeration(session(), unseeded(50), {}, 'EA-TEST-1');
    await flush();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.issueTitle).toBe(
      'SEC-HIGH: Possible account enumeration on /api/accounts/*/profile. '
      + `214 distinct account IDs requested by 1 session in ${logs.WINDOW_MINUTES} min.`,
    );
    expect(alert.customer).toBe('4491bcfa');
    expect(alert.errorType).toBe('BrokenObjectLevelAuthorization');
    expect(alert.skipVulnerablePr).toBe(true);
    expect(alert.promptAppendix).toContain('CWE-639');
    expect(alert.extra.exposedFields).toEqual(['email', 'linkedPlatforms', 'lastLogin.ip']);
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'source_ip', value: logs.SOURCE_IP },
      { key: 'session_id', value: logs.ATTACKER_SESSION },
      { key: 'distinct_accounts', value: '214' },
      { key: 'alert_path', value: 'instant' },
    ]));
  });

  test('later distinct accounts do not open a second investigation', async () => {
    service.trackEnumeration(session(), unseeded(50), {}, 'EA-TEST-1');
    service.trackEnumeration(session(), unseeded(51), {}, 'EA-TEST-2');
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('re-arming starts a fresh window so the next replay alerts again', async () => {
    service.trackEnumeration(session(), unseeded(50), {}, 'EA-TEST-1');
    await flush();
    const rearm = service.rearmDetection(Date.now() + service.REARM_COOLDOWN_MS);
    expect(rearm.rearmed).toBe(true);
    expect(rearm.distinctAccounts).toBe(logs.SEEDED_IDS.length);
    expect(rearm.alerted).toBe(false);

    service.trackEnumeration(session(), unseeded(50), {}, 'EA-TEST-2');
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('re-arming right after an alert is held by the cooldown', async () => {
    service.trackEnumeration(session(), unseeded(50), {}, 'EA-TEST-1');
    await flush();
    const rearm = service.rearmDetection();
    expect(rearm.rearmed).toBe(false);
    expect(rearm.retryAfterSeconds).toBeGreaterThan(0);
    expect(rearm.alerted).toBe(true);

    service.trackEnumeration(session(), unseeded(51), {}, 'EA-TEST-2');
    await flush();
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('an account already in the window does not cross the threshold', async () => {
    service.trackEnumeration(session(), logs.SEEDED_IDS[0], {}, 'EA-TEST-3');
    await flush();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a session reading its own account is not enumeration', async () => {
    service.trackEnumeration(session(), OWNER, {}, 'EA-TEST-4');
    await flush();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
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

  test('GET /api/4491bcfa/friends returns public cards only', async () => {
    const res = await request(server, '/api/4491bcfa/friends', { 'x-ea-session': SESSION });
    expect(res.status).toBe(200);
    expect(res.body.friends.length).toBe(service.FRIEND_IDS.length);
    res.body.friends.forEach((f) => {
      expect(f).not.toHaveProperty('email');
      expect(f).not.toHaveProperty('lastLogin');
      expect(logs.SEEDED_IDS).toContain(f.accountId);
    });
  });

  test('GET /api/4491bcfa/friends returns 401 without a session', async () => {
    const res = await request(server, '/api/4491bcfa/friends');
    expect(res.status).toBe(401);
  });

  test('GET /api/accounts/:id/card is a public, cross-account card without private fields', async () => {
    const res = await request(server, `/api/accounts/${service.FRIEND_IDS[0]}/card`, { 'x-ea-session': SESSION });
    expect(res.status).toBe(200);
    expect(res.body.card.accountId).toBe(service.FRIEND_IDS[0]);
    expect(Object.keys(res.body.card).sort()).toEqual(
      ['accountId', 'avatarColor', 'country', 'displayName', 'eaId', 'platforms'],
    );
  });

  test('GET /api/4491bcfa/monitor reports the seeded detection window', async () => {
    const res = await request(server, '/api/4491bcfa/monitor');
    expect(res.status).toBe(200);
    expect(res.body.threshold).toBe(214);
    expect(res.body.distinctAccounts).toBe(logs.SEEDED_IDS.length);
    expect(res.body.alerted).toBe(false);
  });

  test('POST /api/4491bcfa/monitor/rearm resets the window to the seeded count', async () => {
    service.trackEnumeration(service.resolveSession(SESSION), 'EA-100250', {}, 'EA-TEST-R');
    const { port } = server.address();
    const res = await new Promise((resolve, reject) => {
      http.request({ port, path: '/api/4491bcfa/monitor/rearm', method: 'POST' }, (r) => {
        let body = '';
        r.on('data', (c) => { body += c; });
        r.on('end', () => resolve({ status: r.statusCode, body: JSON.parse(body) }));
      }).on('error', reject).end();
    });
    expect(res.status).toBe(200);
    expect(res.body.rearmed).toBe(false);
    expect(res.body.retryAfterSeconds).toBeGreaterThan(0);
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
