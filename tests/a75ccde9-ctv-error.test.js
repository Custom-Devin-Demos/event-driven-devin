jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: true })),
}));
jest.mock('../app/services/devin-api', () => ({
  listOrgUsers: jest.fn(() => Promise.resolve([])),
  listEnterpriseAdmins: jest.fn(() => Promise.resolve([])),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: {
    captureException: jest.fn(),
    withScope: jest.fn((callback) => callback({ setTransactionName: jest.fn(), addEventProcessor: jest.fn() })),
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

  it('suppresses repeat alerts for the same failure within the cooldown', async () => {
    await ctv.reportAppFailure(REPORT).sessionPromise;
    const second = ctv.reportAppFailure({ ...REPORT, stack: 'different frames' });
    expect(second.suppressed).toBe('cooldown');
    await expect(second.sessionPromise).resolves.toEqual({ triggered: false, suppressed: 'cooldown' });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const res = await post(server, JSON.stringify(REPORT), 'text/plain');
    expect(res.body.alertQueued).toBe(false);
    expect(res.body.suppressed).toBe('cooldown');
  });

  it('still alerts for a different failure or platform inside the cooldown', async () => {
    await ctv.reportAppFailure(REPORT).sessionPromise;
    await ctv.reportAppFailure({ ...REPORT, platform: 'vizio' }).sessionPromise;
    await ctv.reportAppFailure({ ...REPORT, message: 'ReferenceError: Intl is not defined' }).sessionPromise;
    expect(createSessionAndAlert).toHaveBeenCalledTimes(3);
  });

  it('lets the next report retry when alert delivery fails', async () => {
    createSessionAndAlert.mockImplementationOnce(() => Promise.resolve(null));
    await ctv.reportAppFailure(REPORT).sessionPromise;
    createSessionAndAlert.mockImplementationOnce(() => Promise.reject(new Error('slack down')));
    await ctv.reportAppFailure(REPORT).sessionPromise;
    const third = ctv.reportAppFailure(REPORT);
    expect(third.suppressed).toBe(false);
    await third.sessionPromise;
    expect(createSessionAndAlert).toHaveBeenCalledTimes(3);
  });

  it('caps alerts per hour across distinct signatures', async () => {
    for (let i = 0; i < 7; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await ctv.reportAppFailure({ ...REPORT, message: `TypeError: failure ${'x'.repeat(i)}` }).sessionPromise;
    }
    expect(createSessionAndAlert).toHaveBeenCalledTimes(5);
  });

  it('does not name a person when the report carries no identity, and bounds metric tags', async () => {
    const { incrementMetric } = require('../app/telemetry/datadog');
    await ctv.reportAppFailure({ ...REPORT, message: 'Zx9kqError: forged' }).sessionPromise;
    const args = createSessionAndAlert.mock.calls[0][0];
    expect(args.devinEmail).toBeUndefined();
    expect(args.slackMemberId).toBeUndefined();
    expect(incrementMetric).toHaveBeenLastCalledWith('fox_one_ctv.client_error', expect.objectContaining({ errorClass: 'Other' }));
  });
});
