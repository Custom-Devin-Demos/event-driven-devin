jest.mock('../app/services/devin-session', () => ({ createSessionAndAlert: jest.fn(() => Promise.resolve({})) }));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn(), withScope: jest.fn((fn) => fn({ addEventProcessor: jest.fn() })) },
}));

const express = require('express');
const { Sentry } = require('../app/telemetry/sentry');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { ERROR_PATH, VALUES, REPO, CULPRIT, PROMPT, validReport } = require('../app/services/verticals/nourish-mobile');
const router = require('../app/routes/verticals/nourish-mobile');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { getCustomerConfig } = require('../config/customers');

const body = { ...VALUES, platform: 'ios' };
let server;
let clock;

async function start(options = {}) {
  const app = express();
  app.use(router.createRouter({ now: () => clock, ...options }));
  // Match the production order: bridge before the general JSON parser.
  app.use(express.json());
  server = await new Promise((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
  });
}

async function post(payload = body, headers = {}, query = '') {
  const response = await fetch(`http://127.0.0.1:${server.address().port}${ERROR_PATH}${query}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof payload === 'string' ? payload : JSON.stringify(payload),
  });
  return { status: response.status, data: await response.json() };
}

beforeEach(() => {
  jest.clearAllMocks();
  delete process.env.NOURISH_REPORTS_DISABLED;
  clock = 1000000;
});
afterEach(async () => {
  delete process.env.NOURISH_REPORTS_DISABLED;
  if (server) {
    await new Promise((resolve) => server.close(resolve));
    server = null;
  }
});

describe('strict Nourish fixture validation', () => {
  test.each(['ios', 'android', 'web'])('accepts %s', (platform) => {
    expect(validReport({ ...body, platform })).toBe(true);
  });
  test.each(Object.keys(body))('rejects missing, wrong type or non-allowlisted %s', (key) => {
    const missing = { ...body };
    delete missing[key];
    expect(validReport(missing)).toBe(false);
    for (const value of [null, {}, [], true, 2, 'arbitrary caller text']) {
      expect(validReport({ ...body, [key]: value })).toBe(false);
    }
  });
  test.each([null, [], {}, '', 1])('rejects empty/invalid body %p', (value) => {
    expect(validReport(value)).toBe(false);
  });
  test.each(['message', 'stackTrace', 'image', 'patient', 'repo', 'devinOrgId'])('rejects extra %s', (key) => {
    expect(validReport({ ...body, [key]: 'PRIVATE' })).toBe(false);
  });
});

describe('real Nourish router over HTTP', () => {
  test('rejects invalid schema, extra keys, malformed JSON and oversized bodies without side effects', async () => {
    await start();
    expect((await post({})).status).toBe(400);
    expect((await post({ ...body, message: 'PRIVATE' })).status).toBe(400);
    expect((await post('{bad')).status).toBe(400);
    expect((await post({ ...body, image: 'x'.repeat(3000) })).status).toBe(413);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('dedups every allowed tuple and expires it after the window', async () => {
    await start();
    const first = await post();
    expect(first).toEqual({ status: 202, data: { accepted: true, reportId: expect.any(String), duplicate: false } });
    expect(await post()).toEqual({ status: 202, data: { ...first.data, duplicate: true } });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const android = await post({ ...body, platform: 'android' });
    expect(android.data.reportId).not.toBe(first.data.reportId);
    clock += 600000;
    const expired = await post();
    expect(expired.data.reportId).not.toBe(first.data.reportId);
    expect(expired.data.duplicate).toBe(false);
  });

  test.each([
    [{ 'x-synthetic': '1' }, ''], [{ 'x-synthetic': '' }, ''],
    [{ 'x-oncall-mode': '1' }, ''], [{}, '?reports=off'],
  ])('suppression %p %s produces zero side effects', async (headers, query) => {
    await start();
    expect((await post(body, headers, query)).status).toBe(202);
    expect(Sentry.withScope).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('kill switch produces zero side effects and suppressed reports dedup', async () => {
    process.env.NOURISH_REPORTS_DISABLED = '1';
    await start();
    const first = await post();
    delete process.env.NOURISH_REPORTS_DISABLED;
    expect((await post()).data).toEqual({ ...first.data, duplicate: true });
    expect(Sentry.withScope).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('invalid/random fixture IDs and duplicates cannot bypass IP limit', async () => {
    await start({ perClient: 3 });
    expect((await post({ ...body, fixtureId: 'random-1' })).status).toBe(400);
    expect((await post({ ...body, fixtureId: 'random-2' })).status).toBe(400);
    expect((await post(body, { 'x-synthetic': '1' })).status).toBe(202);
    expect((await post(body, { 'x-forwarded-for': '203.0.113.2' })).status).toBe(429);
    expect((await post({ ...body, fixtureId: 'random-3' })).status).toBe(429);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('global limiter counts even malformed and oversized bodies, before parsing', async () => {
    await start({ perClient: 100, globalMax: 2 });
    expect((await post('{bad')).status).toBe(400);
    expect((await post('x'.repeat(3000))).status).toBe(413);
    expect((await post()).status).toBe(429);
    clock += 600000;
    expect((await post(body, { 'x-synthetic': '1' })).status).toBe(202);
  });

  test('live report uses only constants/allowlisted values, fixed repo and macOS', async () => {
    await start();
    const result = await post(body, { 'x-untrusted-message': 'PRIVATE', authorization: 'PRIVATE' }, '?message=PRIVATE');
    expect(result.status).toBe(202);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ repos: [REPO], sessionPlatform: 'macos', promptAppendix: PROMPT, skipVulnerablePr: true });
    expect(JSON.stringify(alert)).not.toContain('PRIVATE');
    expect(PROMPT).toContain('React Native / Expo');
    expect(PROMPT).toContain('EXPO_PUBLIC_NOURISH_DISABLE_FAILURE_REPORTS=1');
    expect(PROMPT).toContain('DRAFT [DO NOT MERGE]');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][0].message).toBe('Seeded meal analysis response is missing nutrients');
    const scope = { addEventProcessor: jest.fn() };
    Sentry.withScope.mock.calls[0][0](scope);
    const sanitize = scope.addEventProcessor.mock.calls[0][0];
    const event = sanitize({ event_id: 'id', exception: { values: [] }, request: { data: 'PRIVATE' }, user: { email: 'PRIVATE' }, breadcrumbs: ['PRIVATE'], tags: { other: 'PRIVATE' } });
    expect(JSON.stringify(event)).not.toContain('PRIVATE');
    expect(event).toMatchObject({ culprit: CULPRIT, tags: { alert_path: 'instant' } });
    expect(getCustomerConfig('nourish-mobile').githubOrg).toBe('COG-GTM');
  });

  test('asynchronous alert failures do not reject the accepted report or retry on duplicate', async () => {
    createSessionAndAlert.mockRejectedValueOnce(new Error('unavailable'));
    await start();
    expect((await post()).status).toBe(202);
    expect((await post()).data.duplicate).toBe(true);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('webhook recognizes instant tags and tagless issue culprits', () => {
    expect(isInstantPathEvent({ tags: [{ key: 'alert_path', value: 'instant' }] })).toBe(true);
    expect(isInstantPathEvent({ culprit: CULPRIT })).toBe(true);
    expect(isInstantPathEvent({ culprit: '/api/nourish/mobile/error' })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'nourish-mobile' })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'unrelated' })).toBe(false);
  });
});
