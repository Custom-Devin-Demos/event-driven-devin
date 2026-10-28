/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const logger = require('../app/telemetry/logger');
const contactRoutes = require('../app/routes/verticals/22ab3789');

const IDENTITY = {
  devinUserId: 'clerk-user_demo',
  devinOrgId: 'org_demo',
  devinEmail: 'presenter@example.test',
};

function postContact(body) {
  const app = express();
  app.use(express.json());
  app.use(contactRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/22ab3789/contact-requests',
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
  logger.info.mockClear();
  logger.error.mockClear();
});

describe('Lumen homepage contact request', () => {
  test('fails to route the header Contact request and alerts with the presenter identity', async () => {
    const { status, body } = await postContact({ locale: 'en-us', topic: 'general', source: 'header', ...IDENTITY });

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('TypeError');
    expect(body.requestId).toEqual(expect.any(String));
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: '22ab3789',
      errorType: 'TypeError',
      culprit: expect.stringContaining('app/services/verticals/22ab3789.js'),
      ...IDENTITY,
      extra: expect.objectContaining({ requestId: body.requestId }),
    }));
  });

  test.each([
    [{ locale: 'english' }, 'INVALID_LOCALE'],
    [{ locale: 'en-us', topic: 'free-stuff' }, 'INVALID_TOPIC'],
    [{ locale: 'en-zz' }, 'MARKET_NOT_SERVED'],
  ])('rejects %p with a 400 and no alert', async (payload, code) => {
    const { status, body } = await postContact({ ...payload, ...IDENTITY });

    expect(status).toBe(400);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.code).toBe(code);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

});
