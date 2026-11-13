jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/services/devin-api', () => ({
  listOrgUsers: jest.fn(() => Promise.resolve([])),
  listEnterpriseAdmins: jest.fn(() => Promise.resolve([])),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: {
    captureException: jest.fn(),
    withScope: jest.fn((callback) => {
      const scope = { setTransactionName: jest.fn(), addEventProcessor: jest.fn() };
      callback(scope);
      return scope;
    }),
  },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const http = require('http');
const express = require('express');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { listOrgUsers } = require('../app/services/devin-api');
const { Sentry } = require('../app/telemetry/sentry');
const {
  APP_REMEDIATION_DIRECTIVE,
  APP_RELEASE,
  APP_REPO,
  APP_SERVICE,
  APP_SOURCE_PREFIX,
  CUSTOMER,
  IOS_ERROR_PATH,
  TOAST_IOS_SESSION_PLATFORM,
  isAppReport,
} = require('../app/services/verticals/toast-ios');
const live = require('../app/services/verticals/toast-live');
const router = require('../app/routes/verticals/toast-ios');

const LIVE = '/api/toast/live/toast-trattoria';

const MULTIPLAYER_REPORT = {
  service: APP_SERVICE,
  source: `${APP_SOURCE_PREFIX}ios`,
  release: APP_RELEASE,
  platform: 'ios',
  screen: 'out_of_stock',
  action: 'eightySixItem',
  errorType: 'MenuSyncError.staleMenuVersion',
  errorCode: 'TST-86-4091',
  errorMessage: "Couldn't 86 Margarita. Menu changed on another device.",
  stackTrace: 'MenuSyncEngine.submit(_:) (ToastNowCore/Sources/ToastNowCore/MenuSyncEngine.swift:120)',
  device: 'iPhone 17 (Simulator)',
  osVersion: 'iOS 26.5',
  appVersion: '2026.11.0',
  restaurantGuid: 'toast-trattoria',
  location: 'All locations',
  managerName: 'Marco D.',
  deviceId: 'device-marco',
  multiplayer: {
    participants: [
      { managerName: 'Max R.', deviceId: 'device-max', device: 'iPhone 17 Pro' },
      { managerName: 'Marco D.', deviceId: 'device-marco', device: 'iPhone 17' },
    ],
    menuVersionKnown: 1,
    menuVersionServer: 2,
    opId: 'op-1',
  },
  devinUserId: '',
  devinEmail: '',
  devinOrgId: '',
};

let server;
let baseUrl;

async function request(method, path, body) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, body: await response.json() };
}

function openStream(query) {
  return new Promise((resolve, reject) => {
    const events = [];
    const waiters = [];
    const req = http.get(`${baseUrl}${LIVE}/stream?${new URLSearchParams(query)}`, (res) => {
      let buffer = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        buffer += chunk;
        let index = buffer.indexOf('\n\n');
        while (index >= 0) {
          const frame = buffer.slice(0, index);
          buffer = buffer.slice(index + 2);
          const event = (frame.match(/^event: (.*)$/m) || [])[1];
          const data = (frame.match(/^data: (.*)$/m) || [])[1];
          if (event) {
            events.push({ event, data: JSON.parse(data) });
            waiters.splice(0).forEach((fn) => fn());
          }
          index = buffer.indexOf('\n\n');
        }
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        events,
        async next(name) {
          for (;;) {
            const found = events.find((e) => e.event === name && !e.seen);
            if (found) { found.seen = true; return found.data; }
            await new Promise((r) => { waiters.push(r); });
          }
        },
        close: () => req.destroy(),
      });
    });
    req.on('error', reject);
  });
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => { server.close(done); });

beforeEach(async () => {
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
  listOrgUsers.mockClear();
  live.reset('toast-trattoria');
});

describe('Toast Now iOS failure report bridge', () => {
  test('accepts a multiplayer report and raises a macOS triage session for ios-demos', async () => {
    const { status, body } = await request('POST', IOS_ERROR_PATH, MULTIPLAYER_REPORT);
    expect(status).toBe(202);
    expect(body).toMatchObject({ received: true, status: 'accepted', service: APP_SERVICE, sessionRequested: true });
    await new Promise((resolve) => { setImmediate(resolve); });

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({
      customer: CUSTOMER,
      service: APP_SERVICE,
      sessionPlatform: 'macos',
      slackMemberId: '',
      slackMemberIdFallback: '',
      issueTitle: "MenuSyncError.staleMenuVersion: Couldn't 86 Margarita. Menu changed on another device.",
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
      release: APP_RELEASE,
    });
    expect(alert.extra).toMatchObject({
      errorCode: 'TST-86-4091',
      action: 'eightySixItem',
      participants: 'Max R. (iPhone 17 Pro), Marco D. (iPhone 17)',
      menuVersionKnown: 1,
      menuVersionServer: 2,
    });
    expect(JSON.parse(alert.extra.multiplayer).participants).toHaveLength(2);
    expect(alert.tags).toEqual(expect.arrayContaining([{ key: 'multiplayer', value: 'true' }]));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('accepts any action, e.g. a single-device editShift report with a labor object', async () => {
    const report = {
      ...MULTIPLAYER_REPORT,
      action: 'editShift',
      screen: 'team_member',
      errorType: 'LaborError.overlap',
      multiplayer: undefined,
      labor: { employee: 'Claudia W.', shiftId: 's-1', nested: { dropped: true } },
    };
    const { status } = await request('POST', IOS_ERROR_PATH, report);
    expect(status).toBe(202);
    await new Promise((resolve) => { setImmediate(resolve); });
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.extra.action).toBe('editShift');
    expect(alert.extra.multiplayer).toBeUndefined();
    expect(JSON.parse(alert.extra.labor)).toEqual({ employee: 'Claudia W.', shiftId: 's-1' });
    expect(alert.tags).toEqual(expect.arrayContaining([{ key: 'multiplayer', value: 'false' }]));
  });

  test('rejects reports from other clients without alerting', async () => {
    const { status, body } = await request('POST', IOS_ERROR_PATH, { ...MULTIPLAYER_REPORT, service: 'customer-gap-ios' });
    expect(status).toBe(400);
    expect(body.received).toBe(false);
    expect(isAppReport({ source: 'toast-now/ios', service: APP_SERVICE })).toBe(true);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('remediation directive scopes the fix and requires a multi-simulator reproduction', () => {
    expect(TOAST_IOS_SESSION_PLATFORM).toBe('macos');
    expect(APP_REMEDIATION_DIRECTIVE).toContain(APP_REPO);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('`ToastNowCore/` and `ToastNowMobile/` only');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('TOAST_DISABLE_FAILURE_REPORTS=1');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('DIFFERENT device types');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('at least 3 simulators');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('[DEMO — DO NOT MERGE]');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('never merge');
  });

  test('caps accepted reports per window', () => {
    const start = Date.now();
    let accepted = 0;
    for (let i = 0; i < 15; i += 1) if (router.reserveReportSlot(start + 24 * 60 * 60 * 1000 + i)) accepted += 1;
    expect(accepted).toBe(10);
  });
});

describe('Toast live menu sync', () => {
  test('serves the seed menu', async () => {
    const { status, body } = await request('GET', `${LIVE}/menu`);
    expect(status).toBe(200);
    expect(body.version).toBe(live.SEED_VERSION);
    expect(body.items.find((i) => i.guid === 'item-mocha').outOfStock).toBe(true);
    expect(body.items.find((i) => i.guid === 'item-quesadilla').outOfStock).toBe(false);
    expect((await request('GET', '/api/toast/live/other/menu')).status).toBe(404);
  });

  test('applies ops on the current version and 409s stale ones with the server version', async () => {
    const op = { opId: 'op-a', baseVersion: 1, itemGuid: 'item-quesadilla', outOfStock: true, managerName: 'Max R.', deviceId: 'd1' };
    expect(await request('POST', `${LIVE}/ops`, op)).toEqual({ status: 200, body: { version: 2 } });
    const stale = { ...op, opId: 'op-b', itemGuid: 'item-margarita', managerName: 'Marco D.', deviceId: 'd2' };
    expect(await request('POST', `${LIVE}/ops`, stale)).toEqual({
      status: 409, body: { error: 'STALE_MENU_VERSION', serverVersion: 2 },
    });
    expect(await request('POST', `${LIVE}/ops`, { ...stale, baseVersion: 2 })).toEqual({ status: 200, body: { version: 3 } });
    expect((await request('POST', `${LIVE}/ops`, op)).body).toEqual({ version: 2, duplicate: true });
    expect((await request('POST', `${LIVE}/ops`, { ...op, opId: 'x', baseVersion: 'nope' })).status).toBe(400);
    expect((await request('POST', `${LIVE}/ops`, { ...op, opId: 'y', baseVersion: 3, itemGuid: 'nope' })).status).toBe(404);
  });

  test('reset restores the seed', async () => {
    await request('POST', `${LIVE}/ops`, { opId: 'op-r', baseVersion: 1, itemGuid: 'item-mocha', outOfStock: false });
    const { body } = await request('POST', `${LIVE}/reset`);
    expect(body.version).toBe(live.SEED_VERSION);
    expect(body.items.find((i) => i.guid === 'item-mocha').outOfStock).toBe(true);
  });

  test('streams remote ops, presence and Manager Log replies over SSE', async () => {
    const max = await openStream({ managerName: 'Max R.', deviceId: 'device-max', device: 'iPhone 17 Pro' });
    const marco = await openStream({ managerName: 'Marco D.', deviceId: 'device-marco', device: 'iPhone 17' });
    try {
      expect(max.status).toBe(200);
      expect(max.headers['content-type']).toContain('text/event-stream');
      expect((await marco.next('hello')).version).toBe(1);

      let presence = await max.next('presence');
      while (presence.presence.length < 2) presence = await max.next('presence');
      expect(presence.presence.map((p) => p.managerName).sort()).toEqual(['Marco D.', 'Max R.']);
      expect((await request('GET', `${LIVE}/menu`)).body.presence).toHaveLength(2);

      await request('POST', `${LIVE}/ops`, {
        opId: 'op-s', baseVersion: 1, itemGuid: 'item-quesadilla', outOfStock: true, managerName: 'Max R.', deviceId: 'device-max',
      });
      expect(await marco.next('op')).toMatchObject({
        opId: 'op-s', version: 2, itemGuid: 'item-quesadilla', itemName: 'Quesadilla', outOfStock: true, managerName: 'Max R.',
      });

      const reply = { id: 'r1', entryId: 'log-1', author: 'Marco D.', text: 'Thanks Max!', postedAt: 'now', deviceId: 'device-marco' };
      expect((await request('POST', `${LIVE}/log`, reply)).status).toBe(200);
      expect(await max.next('reply')).toMatchObject({ id: 'r1', text: 'Thanks Max!' });
      expect((await request('POST', `${LIVE}/log`, { ...reply, text: '  ' })).status).toBe(400);
    } finally {
      max.close();
      marco.close();
    }
  });
});
