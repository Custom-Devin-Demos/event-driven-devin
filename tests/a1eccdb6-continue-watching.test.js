/* global describe, expect, test, jest, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ session: { url: 'https://app.devin.ai/sessions/abc' } })),
}));
jest.mock('../app/services/jira', () => ({
  isConfigured: jest.fn(() => true),
  createIssue: jest.fn(() => Promise.resolve({ id: '1', key: 'JOAN-900', url: 'https://cog-gtm.atlassian.net/browse/JOAN-900' })),
  addComment: jest.fn(() => Promise.resolve({ id: '2' })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const jira = require('../app/services/jira');
const routes = require('../app/routes/verticals/a1eccdb6');
const {
  loadContinueWatching, buildContinueWatching, watchLog, CATALOG, JIRA_PROJECT_KEY,
  reportFailure, resetIncidents,
} = require('../app/services/verticals/a1eccdb6');

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(routes);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) })));
      });
      req.on('error', (err) => server.close(() => reject(err)));
      req.end(payload);
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('watch history fixtures', () => {
  test.each(['alex', 'sam'])('every %s event refers to a catalog title', (profileId) => {
    watchLog(profileId).forEach((e) => expect(CATALOG[e.contentId]).toBeDefined());
  });

  test('defaults to the JOAN Jira project', () => {
    expect(JIRA_PROJECT_KEY).toBe('JOAN');
  });
});

describe('buildContinueWatching', () => {
  test('keeps one tile per title, newest watch first, at the latest progress', () => {
    const rail = buildContinueWatching(watchLog('alex'));
    const ids = rail.map((t) => t.contentId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toBe('ep-harbor-lights-s2e3');
    expect(rail[0].progressSeconds).toBe(2730);
    const times = rail.map((t) => Date.parse(t.watchedAt));
    expect([...times].sort((a, b) => b - a)).toEqual(times);
    expect(rail[0].percentComplete).toBe(Math.round((2730 / 3060) * 100));
  });
});

describe('loadContinueWatching', () => {
  test('loads Alex\'s rail without alerting', async () => {
    const result = await loadContinueWatching({ profileId: 'alex' });
    expect(result.success).toBe(true);
    expect(result.items).toHaveLength(6);
    expect(result.requestId).toMatch(/^CW-/);
    expect(jira.createIssue).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects an unknown profile with a 400 and no alert', async () => {
    await expect(loadContinueWatching({ profileId: 'nobody' })).rejects.toMatchObject({
      statusCode: 400, code: 'CW_PROFILE_REQUIRED',
    });
    expect(jira.createIssue).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('routes', () => {
  test('GET /api/a1eccdb6/profiles lists both profiles', async () => {
    const res = await request('GET', '/api/a1eccdb6/profiles');
    expect(res.body.profiles.map((p) => p.id)).toEqual(['alex', 'sam']);
  });

  test('POST /api/a1eccdb6/continue-watching succeeds for Alex', async () => {
    const res = await request('POST', '/api/a1eccdb6/continue-watching', { profileId: 'alex' });
    expect(res.status).toBe(200);
    expect(res.body.items[0].title).toBe('Harbor Lights');
  });

  test('POST /api/a1eccdb6/continue-watching returns 400 without a profile', async () => {
    const res = await request('POST', '/api/a1eccdb6/continue-watching', {});
    expect(res.status).toBe(400);
    expect(res.body).toMatchObject({ success: false, code: 'CW_PROFILE_REQUIRED', jira: null });
  });
});

describe('a1eccdb6 failure reporting', () => {
  beforeEach(() => resetIncidents());

  test('concurrent failures share one filing and one dispatch', async () => {
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const fileIncident = jest.fn(async () => { await gate; return { issue: { key: 'JOAN-1' } }; });
    const dispatch = jest.fn(async () => true);
    const first = reportFailure('sig-a', fileIncident, dispatch);
    const second = reportFailure('sig-a', fileIncident, dispatch);
    release();
    const [a, b] = await Promise.all([first, second]);
    await a.dispatching;
    expect(a.filed).toBe(b.filed);
    expect(fileIncident).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(1);
  });

  test('a dispatch that starts no session is retried against the same ticket', async () => {
    const fileIncident = jest.fn(async () => ({ issue: { key: 'JOAN-2' } }));
    const dispatch = jest.fn()
      .mockResolvedValueOnce(false)
      .mockResolvedValueOnce(true);
    await (await reportFailure('sig-b', fileIncident, dispatch)).dispatching;
    await (await reportFailure('sig-b', fileIncident, dispatch)).dispatching;
    await reportFailure('sig-b', fileIncident, dispatch);
    expect(fileIncident).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(dispatch.mock.calls[1][0]).toEqual({ issue: { key: 'JOAN-2' } });
  });

  test('a dispatch that throws is retried on the next failure', async () => {
    const fileIncident = jest.fn(async () => ({ issue: null }));
    const dispatch = jest.fn()
      .mockRejectedValueOnce(new Error('slack down'))
      .mockResolvedValueOnce(true);
    await (await reportFailure('sig-c', fileIncident, dispatch)).dispatching;
    await (await reportFailure('sig-c', fileIncident, dispatch)).dispatching;
    expect(fileIncident).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledTimes(2);
  });
});
