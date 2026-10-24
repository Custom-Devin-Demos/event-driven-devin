/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test, fetch */

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(),
}));

const fs = require('fs');
const http = require('http');
const express = require('express');
const path = require('path');
const { Sentry } = require('../app/telemetry/sentry');
const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const {
  createSession,
  issuerFor,
  rolloutBucket,
  isSessionActive,
  SESSION_ISSUERS,
  RELEASE,
} = require('../app/services/oncall-verticals/memberlogin');
const { ALERT_SCENARIOS, postOncallAlert } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

jest.setTimeout(30000);

const SLUG = 'db0a7e02';
const FAILING_USER = 'cardmember01';
const PASSING_USER = 'jmorgan';

describe('member login on-call vertical', () => {
  let server;
  let baseUrl;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(require('../app/routes/oncall'));
    app.use(require('../app/routes/oncall-verticals'));
    server = http.createServer(app).listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      done();
    });
  });

  afterAll((done) => {
    server.closeAllConnections();
    server.close(() => stopGateway().then(() => done()));
  });

  beforeEach(() => jest.clearAllMocks());

  test('about 1 in 5 users are in the failing cohort, and the same users every time', () => {
    const ids = Array.from({ length: 5000 }, (_, i) => `member${i}`);
    const failing = ids.filter((id) => issuerFor(id) === 'session-v2').length;
    expect(failing / ids.length).toBeGreaterThan(0.17);
    expect(failing / ids.length).toBeLessThan(0.23);
    for (const id of ids.slice(0, 200)) {
      expect(issuerFor(id)).toBe(issuerFor(id));
      expect(issuerFor(id.toUpperCase())).toBe(issuerFor(id));
      expect(rolloutBucket(id)).toBeGreaterThanOrEqual(0);
    }
    expect(issuerFor(FAILING_USER)).toBe('session-v2');
    expect(issuerFor(PASSING_USER)).toBe('session-v1');
  });

  test('tokens from the failing cohort are already expired when issued', () => {
    const now = Date.now();
    expect(isSessionActive(SESSION_ISSUERS['session-v1'].issue(PASSING_USER, now), now)).toBe(true);
    expect(isSessionActive(SESSION_ISSUERS['session-v2'].issue(FAILING_USER, now), now)).toBe(false);
  });

  test('a failing-cohort login is rejected as expired on every retry and reported to Sentry', async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(createSession({ userId: FAILING_USER, password: 'x' })).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    }
    expect(Sentry.captureException).toHaveBeenCalledTimes(3);
    expect(Sentry.captureException.mock.calls[0][1].tags.release).toBe('v7.34');
  });

  test('other users log in and receive a fictional account summary', async () => {
    const session = await createSession({ userId: PASSING_USER, password: 'x', accountType: 'business' });
    expect(session).toMatchObject({ success: true, accountType: 'business' });
    expect(session.account.cardEnding).toMatch(/^\d{5}$/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each([
    [{}],
    [{ userId: 'a', password: 'x' }],
    [{ userId: PASSING_USER }],
  ])('invalid login %j is a 400 without Sentry', async (body) => {
    await expect(createSession(body)).rejects.toMatchObject({ code: 'INVALID_LOGIN' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('session route returns a customer-facing 401 for the failing cohort and 200 otherwise', async () => {
    const post = (body) => fetch(`${baseUrl}/api/oncall/memberlogin/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const failed = await post({ userId: FAILING_USER, password: 'x' });
    expect(failed.status).toBe(401);
    const failedBody = await failed.json();
    expect(failedBody).toMatchObject({
      success: false,
      code: 'SESSION_EXPIRED',
      error: 'Your session has expired. Please log in again.',
    });
    expect(JSON.stringify(failedBody)).not.toMatch(/session-v2|issuer|tokenExp|stack|\.js:/i);

    const ok = await post({ userId: PASSING_USER, password: 'x' });
    expect(ok.status).toBe(200);
    expect((await ok.json()).success).toBe(true);

    const invalid = await post({});
    expect(invalid.status).toBe(400);
    await invalid.json();
  });

  test('alert card carries release v7.34, stays metric-shaped, and opens a Devin session', async () => {
    const skin = getOncallSkin(SLUG);
    expect(RELEASE).toBe('v7.34');
    expect(skin.devinSession).toEqual({ auto: true });
    const result = await postOncallAlert('memberlogin', { skin, runRef: 'run-test' });
    expect(result).toMatchObject({ ok: true, channel: 'C0TEST' });
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [, channel, text, blocks] = postMessage.mock.calls[0];
    expect(channel).toBe('C0TEST');
    const card = `${text}\n${JSON.stringify(blocks)}`;
    expect(card).toContain('v7.34');
    expect(card).toContain('member-auth-api');
    expect(card).toContain('demo.memberlogin.session.rejected');
    expect(card).not.toMatch(/stack trace|TypeError|\.js:|app\/services|session-v2|issuer|seconds|millisecond/i);
  });

  test('skin page posts alerts only on a 401 and other scenarios keep alerting on submit', async () => {
    const [skinned, generic, wrong, other] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/${SLUG}`),
      fetch(`${baseUrl}/oncall/memberlogin`),
      fetch(`${baseUrl}/oncall/c/00000000`),
      fetch(`${baseUrl}/oncall/c/e85b5836`),
    ]);
    expect([skinned.status, generic.status, wrong.status, other.status]).toEqual([200, 404, 404, 200]);
    const html = await skinned.text();
    expect(html).toContain('<title>Log In to My Account | American Express</title>');
    expect(html).toContain('NOT ACTUALLY AN AMERICAN EXPRESS SITE');
    expect(html).toContain('const apiPath = "/api/member-auth"');
    expect(html).toContain('const oncallApiPath = "/api/oncall/memberlogin"');
    expect(html).toContain('const alertOnStatus = [401]');
    expect(html).toContain("if (alertOnStatus.indexOf(resp.status) !== -1) postAlertTrigger();");
    expect(html).toContain('/session-cap-banner.js');
    expect(html).not.toContain('All Demos');
    expect(await other.text()).toContain('const alertOnStatus = null');
    await Promise.all([generic.text(), wrong.text()]);
    expect(ALERT_SCENARIOS.memberlogin.retryWindow).toBeUndefined();
  });

  test('native page posts the login body to the legacy path and contains no external images', () => {
    const page = fs.readFileSync(path.join(__dirname, '../app/public/verticals', `${SLUG}.html`), 'utf8');
    expect(page).toContain("fetch('/api/member-auth/session'");
    expect(page).toContain("fetch('/api/config')");
    expect(page).not.toMatch(/<img|aexp-static|americanexpress\.com/i);
  });
});
