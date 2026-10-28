/* global describe, expect, test, jest, beforeEach, afterEach */

jest.mock('../app/telemetry/logger', () => ({
  warn: jest.fn(),
  info: jest.fn(),
  error: jest.fn(),
}));

const crypto = require('crypto');
const logger = require('../app/telemetry/logger');
const { verifyWebhookSignature } = require('../app/middleware/verify-webhook-signature');

const SECRET_ENV = 'TEST_WEBHOOK_SECRET';
const SECRET = 'test-secret-123';
const BODY = { action: 'triggered', id: 42 };
const RAW_BODY = Buffer.from(JSON.stringify(BODY));

function sign(body, { algorithm = 'sha256', encoding = 'hex' } = {}) {
  return crypto.createHmac(algorithm, SECRET).update(body).digest(encoding);
}

function mockReq(headers = {}, { rawBody = RAW_BODY, body = BODY } = {}) {
  return { headers, rawBody, body, path: '/webhooks/test', ip: '127.0.0.1' };
}

function mockRes() {
  const res = {};
  res.status = jest.fn(() => res);
  res.json = jest.fn(() => res);
  return res;
}

function run(middleware, req) {
  const res = mockRes();
  const next = jest.fn();
  middleware(req, res, next);
  return { res, next };
}

describe('verifyWebhookSignature', () => {
  const originalSecret = process.env[SECRET_ENV];

  beforeEach(() => {
    process.env[SECRET_ENV] = SECRET;
    jest.clearAllMocks();
  });

  afterEach(() => {
    if (originalSecret === undefined) delete process.env[SECRET_ENV];
    else process.env[SECRET_ENV] = originalSecret;
  });

  const middleware = verifyWebhookSignature({
    secretEnv: SECRET_ENV,
    signatureHeader: 'x-signature',
  });

  test('passes through when the secret env var is unset', () => {
    delete process.env[SECRET_ENV];
    const { res, next } = run(middleware, mockReq());
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 401 when the signature header is missing', () => {
    const { res, next } = run(middleware, mockReq());
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ error: 'Webhook signature required' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      { path: '/webhooks/test', ip: '127.0.0.1' },
    );
  });

  test('calls next() for a valid signature', () => {
    const { res, next } = run(middleware, mockReq({ 'x-signature': sign(RAW_BODY) }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('returns 403 for an invalid signature', () => {
    const { res, next } = run(middleware, mockReq({ 'x-signature': 'deadbeef' }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ error: 'Invalid webhook signature' });
    expect(logger.warn).toHaveBeenCalledWith(
      expect.any(String),
      { path: '/webhooks/test', ip: '127.0.0.1' },
    );
  });

  test('returns 403 for a same-length signature over a different body', () => {
    const forged = sign(Buffer.from('{"action":"other"}'));
    const { res, next } = run(middleware, mockReq({ 'x-signature': forged }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('strips a configured signature prefix (GitHub-style sha256=<hex>)', () => {
    const github = verifyWebhookSignature({
      secretEnv: SECRET_ENV,
      signatureHeader: 'X-Hub-Signature-256',
      signaturePrefix: 'sha256=',
    });
    const { res, next } = run(github, mockReq({ 'x-hub-signature-256': `sha256=${sign(RAW_BODY)}` }));
    expect(next).toHaveBeenCalledTimes(1);
    expect(res.status).not.toHaveBeenCalled();
  });

  test('rejects a prefixed signature when no prefix is configured', () => {
    const { res, next } = run(middleware, mockReq({ 'x-signature': `sha256=${sign(RAW_BODY)}` }));
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(403);
  });

  test('supports base64 encoding and alternate algorithms', () => {
    const b64 = verifyWebhookSignature({
      secretEnv: SECRET_ENV,
      signatureHeader: 'x-signature',
      algorithm: 'sha1',
      encoding: 'base64',
    });
    const signature = sign(RAW_BODY, { algorithm: 'sha1', encoding: 'base64' });
    const { next } = run(b64, mockReq({ 'x-signature': signature }));
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('falls back to JSON.stringify(req.body) when rawBody is absent', () => {
    const req = mockReq({ 'x-signature': sign(RAW_BODY) }, { rawBody: undefined });
    const { next } = run(middleware, req);
    expect(next).toHaveBeenCalledTimes(1);
  });

  test('throws on missing required options or unsupported encoding', () => {
    expect(() => verifyWebhookSignature({ signatureHeader: 'x-signature' })).toThrow(TypeError);
    expect(() => verifyWebhookSignature({ secretEnv: SECRET_ENV })).toThrow(TypeError);
    expect(() => verifyWebhookSignature({
      secretEnv: SECRET_ENV, signatureHeader: 'x-signature', encoding: 'latin1',
    })).toThrow(TypeError);
  });
});
