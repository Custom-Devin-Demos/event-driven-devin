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
const { approveDocument, buildOutboxEvent, DOC_TYPE_CONFIGS, REVIEW_DOCUMENT } = require('../app/services/verticals/d60dcff1');
const reviewRoutes = require('../app/routes/verticals/d60dcff1');
const customer = require('../config/customers/d60dcff1');

const APPROVAL = { documentId: 'doc-7f3a91c2', configVersion: 'tod_registration@v4', reviewer: 'admin@demo' };

function request(method, path, body, headers = {}) {
  const app = express();
  app.use(express.json());
  app.use(reviewRoutes);

  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? '' : JSON.stringify(body);
      const req = http.request({
        port: server.address().port,
        path,
        method,
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload), ...headers },
      }, (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          server.close();
          resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null });
        });
      });
      req.on('error', (err) => { server.close(); reject(err); });
      req.end(payload);
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('review console approval (d60dcff1)', () => {
  test('customer config is an api-triggered vertical', () => {
    expect(customer).toMatchObject({ triggerMode: 'api' });
  });

  test('the newly published TOD config version has no allocation policy', () => {
    expect(DOC_TYPE_CONFIGS['tod_registration@v4'].allocationPolicy).toBeUndefined();
    expect(DOC_TYPE_CONFIGS['tod_registration@v3'].allocationPolicy).toBeDefined();
  });

  test('approving under the previous config version releases an outbox event', () => {
    const event = buildOutboxEvent({ ...REVIEW_DOCUMENT, configVersion: 'tod_registration@v3' }, 'admin@demo');
    expect(event).toMatchObject({ topic: 'registrations.tod.approved', owner: 'Priya N. Shah', accountNumber: '50917-2214', allocationTotal: 100 });
  });

  test('approving the review document throws a TypeError and raises Sentry + the alert', async () => {
    await expect(approveDocument(APPROVAL)).rejects.toThrow(TypeError);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.issueTitle).toBe("TypeError: Cannot read properties of undefined (reading 'precision')");
    expect(alert.culprit).toBe('app/services/verticals/d60dcff1.js — applyAllocationPolicy');
    expect(alert.verticalLabel).toBe('Intake Factory — Review console approval');
    expect(alert.customer).toBe('d60dcff1');
  });

  test('POST /api/d60dcff1/review/approve returns a 500 with a request id', async () => {
    const res = await request('POST', '/api/d60dcff1/review/approve', APPROVAL);
    expect(res.status).toBe(500);
    expect(res.body).toMatchObject({ success: false, errorClass: 'TypeError', code: 'APPROVAL_FAILED' });
    expect(res.body.requestId).toEqual(expect.any(String));
  });

  test('reproduction requests fail identically without alerting', async () => {
    const res = await request('POST', '/api/d60dcff1/review/approve', APPROVAL, { 'x-synthetic': '1' });
    expect(res.status).toBe(500);
    expect(res.body.errorClass).toBe('TypeError');
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('unknown documents and config versions are handled 400s with no alert', async () => {
    const unknownDoc = await request('POST', '/api/d60dcff1/review/approve', { ...APPROVAL, documentId: 'doc-nope' });
    const unknownConfig = await request('POST', '/api/d60dcff1/review/approve', { ...APPROVAL, configVersion: 'tod_registration@v9' });
    expect(unknownDoc.status).toBe(400);
    expect(unknownConfig.status).toBe(400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('GET /api/d60dcff1/review/document returns the fictional review document', async () => {
    const res = await request('GET', '/api/d60dcff1/review/document');
    expect(res.status).toBe(200);
    expect(res.body.fields.owner_name).toBe('Priya N. Shah');
  });
});

describe('sentry webhook dedupe (d60dcff1)', () => {
  test('approval failures are recognised as instant-path events', () => {
    const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/d60dcff1.js — applyAllocationPolicy', tags: [] })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'other', tags: [{ key: 'alert_path', value: 'instant' }] })).toBe(true);
  });

  test('the captured event carries alert_path: instant', async () => {
    await expect(approveDocument(APPROVAL)).rejects.toThrow(TypeError);
    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');
  });
});
