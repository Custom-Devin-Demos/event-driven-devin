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
    withScope: jest.fn((callback) => callback({ setTransactionName: jest.fn() })),
  },
  initSentry: jest.fn(),
}));
jest.mock('../app/telemetry/datadog', () => ({ incrementMetric: jest.fn() }));

const http = require('http');
const express = require('express');
const { createSessionAndAlert } = require('../app/services/devin-session');
const ctv = require('../app/services/verticals/a75ccde9-ctv');
const router = require('../app/routes/verticals/a75ccde9');

const REPORT = {
  message: 'TypeError: Object.fromEntries is not a function',
  stack: 'TypeError: Object.fromEntries is not a function\n    at groupByLeague (index.js:40:100)',
  platform: 'tizen',
  userAgent: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) Chrome/64.0.3282.0',
  url: 'http://tv.local/?platform=tizen',
  route: 'render',
};

function post(server, body, contentType) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request({ port, path: ctv.ERROR_PATH, method: 'POST', headers: { 'Content-Type': contentType } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

describe('FOX One TV beacon', () => {
  let server;
  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0, () => done());
  });
  afterAll((done) => { server.close(() => done()); });
  beforeEach(() => {
    ctv.resetAlertCooldown();
    createSessionAndAlert.mockClear();
  });

  it('accepts a sendBeacon text/plain report and opens a session pointed at fox-one-ctv', async () => {
    const res = await post(server, JSON.stringify(REPORT), 'text/plain;charset=UTF-8');
    expect(res.status).toBe(202);
    expect(res.body.service).toBe('customer-a75ccde9-ctv');
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const args = createSessionAndAlert.mock.calls[0][0];
    expect(args.promptAppendix).toContain('COG-GTM/fox-one-ctv');
    expect(args.promptAppendix).toContain('Chromium 64');
    expect(args.issueTitle).toContain('tizen, Chrome 64');
  });

  it('accepts JSON too and rejects unknown platforms', async () => {
    expect((await post(server, JSON.stringify(REPORT), 'application/json')).status).toBe(202);
    expect((await post(server, JSON.stringify({ ...REPORT, platform: 'roku' }), 'text/plain')).status).toBe(400);
    expect((await post(server, 'not json', 'text/plain')).status).toBe(400);
  });

  it('suppresses repeat alerts within the cooldown', async () => {
    ctv.reportAppFailure(REPORT);
    const second = ctv.reportAppFailure(REPORT);
    await expect(second.sessionPromise).resolves.toEqual({ triggered: false, suppressed: true });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });
});
