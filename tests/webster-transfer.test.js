/* global describe, expect, test, jest, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
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
const { Sentry } = require('../app/telemetry/sentry');
const { processTransfer, ValidationError, ACCOUNTS } = require('../app/services/verticals/webster');
const websterRoutes = require('../app/routes/verticals/webster');
const { getCustomerConfig } = require('../config/customers');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const IDENTITY = {
  devinUserId: 'user-abc123',
  devinOrgId: 'org-xyz789',
  devinEmail: 'antonio@devindemos.com',
};
const [CHECKING, SAVINGS, VALUE] = ACCOUNTS;

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(websterRoutes);

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = {};
      if (body !== undefined) {
        headers['Content-Type'] = 'application/json';
        headers['Content-Length'] = Buffer.byteLength(payload);
      }
      const req = http.request({
        hostname: '127.0.0.1',
        port: server.address().port,
        path,
        method,
        headers,
      }, (res) => {
        let responseBody = '';
        res.on('data', (chunk) => { responseBody += chunk; });
        res.on('end', () => {
          const contentType = res.headers['content-type'] || '';
          const response = {
            status: res.statusCode,
            body: contentType.includes('application/json') ? JSON.parse(responseBody) : responseBody,
            contentType,
          };
          server.close(() => resolve(response));
        });
      });
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Webster transfers', () => {
  test('the default Private Client Checking transfer throws a TypeError and alerts the clicking user', async () => {
    await expect(processTransfer({
      fromAccount: CHECKING.id, toAccount: SAVINGS.id, amount: 1500, ...IDENTITY,
    })).rejects.toThrow("Cannot read properties of undefined (reading 'rate')");

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('webster');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('calculateTransferFee');
    expect(alert.devinUserId).toBe(IDENTITY.devinUserId);
    expect(alert.devinOrgId).toBe(IDENTITY.devinOrgId);
    expect(alert.devinEmail).toBe(IDENTITY.devinEmail);
    expect(alert.slackMemberId).toBeUndefined();
    expect(alert.promptAppendix).toContain('app/services/verticals/webster.js');
  });

  test('Premier savings and Value checking transfers succeed without alerting', async () => {
    const premier = await processTransfer({ fromAccount: SAVINGS.id, toAccount: CHECKING.id, amount: 500 });
    expect(premier.receipt).toMatchObject({ amount: '500.00', fee: '0.00', totalDebit: '500.00' });

    const value = await processTransfer({ fromAccount: VALUE.id, toAccount: 'EXT-CHASE-4921', amount: 100 });
    expect(value.receipt).toMatchObject({ amount: '100.00', fee: '3.00', totalDebit: '103.00' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    [{ fromAccount: 'constructor', toAccount: SAVINGS.id, amount: 10 }],
    [{ fromAccount: CHECKING.id, toAccount: 'nope', amount: 10 }],
    [{ fromAccount: CHECKING.id, toAccount: CHECKING.id, amount: 10 }],
    [{ fromAccount: CHECKING.id, toAccount: SAVINGS.id, amount: -5 }],
    [{ fromAccount: CHECKING.id, toAccount: SAVINGS.id, amount: 'abc' }],
    [{ fromAccount: VALUE.id, toAccount: SAVINGS.id, amount: 999999 }],
  ])('invalid input is a validation error, not an alert (%#)', async (data) => {
    await expect(processTransfer(data)).rejects.toBeInstanceOf(ValidationError);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('customer config is registered and the webhook treats Webster events as instant-path', () => {
    expect(getCustomerConfig('webster').label).toMatch(/Webster/);
    expect(isInstantPathEvent({ tags: [], culprit: 'app/services/verticals/webster.js — calculateTransferFee' })).toBe(true);
  });
});

describe('Webster routes', () => {
  test('GET /webster serves the page', async () => {
    const res = await request('GET', '/webster');
    expect(res.status).toBe(200);
    expect(res.body).toContain('Webster Bank');
  });

  test('GET /api/webster/accounts lists accounts', async () => {
    const res = await request('GET', '/api/webster/accounts');
    expect(res.body.accounts).toHaveLength(3);
  });

  test('POST /api/webster/transfer returns 500 for the failing account and 400 for bad input', async () => {
    const failed = await request('POST', '/api/webster/transfer', { fromAccount: CHECKING.id, toAccount: SAVINGS.id, amount: 1500 });
    expect(failed.status).toBe(500);
    expect(failed.body).toMatchObject({ errorClass: 'TypeError', code: 'TRANSFER_FAILED' });

    const invalid = await request('POST', '/api/webster/transfer', { fromAccount: CHECKING.id, toAccount: SAVINGS.id, amount: 0 });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('INVALID_TRANSFER');
  });
});
