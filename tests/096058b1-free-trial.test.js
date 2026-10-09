/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const trialRoutes = require('../app/routes/verticals/096058b1');

const IDENTITY = {
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'presenter@example.test',
};

function postTrial(body) {
  const app = express();
  app.use(express.json());
  app.use(trialRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/096058b1/free-trial',
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
        },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
          });
        },
      );
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

afterEach(() => {
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

describe('DIRECTV free trials', () => {
  test('fails on the MySports Extra trial and forwards the presenter identity', async () => {
    const { status, body } = await postTrial({
      preConfigItems: 'MYSPORTS,MYSPORTSEXTRA',
      intent: 'genre',
      trialDays: 5,
      ...IDENTITY,
    });

    expect(status).toBe(500);
    expect(body.errorClass).toBe('TypeError');
    expect(body.error).toMatch(/trialDays/);
    expect(body.requestId).toMatch(/^DTV-[0-9A-F]{8}$/);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: '096058b1',
      errorType: 'TypeError',
      culprit: expect.stringContaining('app/services/verticals/096058b1.js'),
      ...IDENTITY,
      extra: expect.objectContaining({ requestId: body.requestId }),
    }));
  });

  test('starts a MySports-only trial without alerting', async () => {
    const { status, body } = await postTrial({
      preConfigItems: 'MYSPORTS',
      intent: 'genre',
      trialDays: 5,
      ...IDENTITY,
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.firstBill.introPrice).toBe(49.99);
    expect(body.items).toEqual([expect.objectContaining({ code: 'MYSPORTS' })]);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects an unknown offer with a 400 and no alert', async () => {
    const { status, body } = await postTrial({ preConfigItems: 'NOT_A_PLAN', ...IDENTITY });

    expect(status).toBe(400);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe('OFFER_NOT_FOUND');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects MySports Extra without its required pack and no alert', async () => {
    const { status, body } = await postTrial({ preConfigItems: 'MYSPORTSEXTRA', ...IDENTITY });

    expect(status).toBe(400);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe('REQUIRED_PACK_MISSING');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
