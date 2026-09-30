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
const router = require('../app/routes/verticals/918bb443');

let server;
let baseUrl;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${urlPath}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

describe('template studio upload (918bb443)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('workspace returns the staged upload and template library', async () => {
    const res = await request('GET', '/api/918bb443/workspace');
    expect(res.status).toBe(200);
    expect(res.body.staged.uploadId).toBe('UPL-2026-09-4471');
    expect(res.body.staged.sheet.columns).toHaveLength(10);
    expect(res.body.library).toHaveLength(4);
  });

  test('uploading the staged template fails and raises an alert', async () => {
    const res = await request('POST', '/api/918bb443/templates/upload', { uploadId: 'UPL-2026-09-4471' });
    expect(res.status).toBe(500);
    expect(res.body.errorClass).toBe('TypeError');

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.service).toBe('918bb443-api');
    expect(alert.customer).toBeUndefined();
    expect(alert.culprit).toContain('processTemplateUpload');
  });

  test('unknown uploads return 404 without raising an alert', async () => {
    const res = await request('POST', '/api/918bb443/templates/upload', { uploadId: 'UPL-0000' });
    expect(res.status).toBe(404);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
