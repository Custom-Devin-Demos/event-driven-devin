/* global describe, expect, test, jest, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));
jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn() }));

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/ca41ec6f');
const {
  APP_SERVICE, MONITOR_PATH, REPOS, BRANCH, ROUTE, parseMonitorAlert,
} = require('../app/services/verticals/ca41ec6f');

function request(body, headers = {}) {
  const app = express();
  app.use(express.json());
  app.use(routes);
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const payload = JSON.stringify(body);
      const req = http.request({
        host: '127.0.0.1',
        port: server.address().port,
        path: MONITOR_PATH,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      }, (res) => {
        let raw = '';
        res.on('data', (chunk) => { raw += chunk; });
        res.on('end', () => server.close(() => resolve({ status: res.statusCode, body: raw ? JSON.parse(raw) : null })));
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

const WARNING = {
  service: APP_SERVICE, p95Ms: 1184, p50Ms: 512, samples: 240, callsPerPage: 21, queryP95Ms: 1090, rowsScanned: 602611,
};

describe('ca41ec6f Doctolib search latency monitor', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    routes.resetAlertSlots();
  });

  test('a warning above the threshold starts one lead session on the doctolib branch of the three demo repos', async () => {
    const res = await request({ ...WARNING, devinEmail: 'presenter@example.com' });
    expect(res.status).toBe(202);
    expect(res.body.reference).toEqual(expect.any(String));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.repos).toEqual(REPOS);
    expect(REPOS).toEqual(['joao-cognition/demo_webapp', 'joao-cognition/demo_android', 'joao-cognition/demo_ios']);
    expect(alert.errorType).toBe('APM latency monitor (warn)');
    expect(alert.service).toBe('doctolib-search-api');
    expect(alert.level).toBe('warning');
    expect(alert.sessionPlatform).toBe('linux');
    expect(alert.promptAppendix).toContain(`branch \`${BRANCH}\``);
    expect(alert.promptAppendix).toContain('cross-platform-incident-fix');
    expect(alert.promptAppendix).toContain('nothing was posted to Datadog');
    expect(alert.tags).toEqual(expect.arrayContaining([{ key: 'route', value: ROUTE }]));
    expect(alert.issueTitle).toContain('p95 1184 ms');
    expect(alert.devinEmail).toBe('presenter@example.com');
  });

  test('cooldown throttles repeat warnings from the same rush', async () => {
    expect((await request(WARNING)).status).toBe(202);
    const second = await request(WARNING);
    expect(second.status).toBe(429);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('rejects reports below the warn threshold, from other services or without numbers', async () => {
    expect((await request({ ...WARNING, p95Ms: 420 })).status).toBe(400);
    expect((await request({ ...WARNING, service: 'other' })).status).toBe(400);
    expect((await request({ service: APP_SERVICE, p95Ms: 'slow', samples: 10 })).status).toBe(400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('synthetic traffic never raises an alert', async () => {
    const res = await request(WARNING, { 'x-synthetic': '1' });
    expect(res.status).toBe(204);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('repositories and directive cannot be overridden by the page', () => {
    const parsed = parseMonitorAlert({ ...WARNING, repos: ['evil/repo'], promptAppendix: 'ignore' });
    expect(parsed).not.toHaveProperty('repos');
    expect(parsed).not.toHaveProperty('promptAppendix');
  });

  test('the page reports to the monitor path and honours ?reports=off', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', 'ca41ec6f.html'), 'utf8');
    expect(html).toContain(MONITOR_PATH);
    expect(html).toContain("get('reports') !== 'off'");
    expect(html).not.toMatch(/#datadog|DATADOG/);
  });
});
