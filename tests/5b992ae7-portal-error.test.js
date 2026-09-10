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
const {
  reportPortalFailure,
  PORTAL_REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/5b992ae7');
const router = require('../app/routes/verticals/5b992ae7');

const PORTAL_REPORT = {
  source: 'ge-customer-portal/web',
  service: 'customer-5b992ae7-portal',
  release: 'ge-customer-portal@1.0.0',
  environment: 'prod',
  platform: 'web',
  errorType: 'TypeError',
  errorMessage: 'Null check operator used on a null value',
  stackTrace: 'package:ge_customer_portal/domain/engine_coverage.dart 31:20',
  screen: 'inquiry',
  action: 'submit_inquiry',
  operator: 'US',
  segment: 'commercial_narrowbody',
  sentryEventId: null,
  inquiry: { topic: 'technical', program: 'leap', priority: 'normal', market: 'US' },
};

function postJson(server, path, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method: 'POST', headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('GE portal failure report (5b992ae7)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('reportPortalFailure raises the alert under the portal identity, not the legacy inquiry one', () => {
    const { reference } = reportPortalFailure(PORTAL_REPORT);

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];

    expect(alertData).toMatchObject({
      customer: '5b992ae7',
      service: 'customer-5b992ae7-portal',
      verticalLabel: 'GE Aerospace Customer Portal',
      project: 'ge-customer-portal',
      release: 'ge-customer-portal@1.0.0',
      platform: 'web',
      errorType: 'TypeError',
      errorValue: 'Null check operator used on a null value',
      promptAppendix: PORTAL_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.service).not.toBe('customer-5b992ae7-inquiry');
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'service', value: 'customer-5b992ae7-portal' },
      { key: 'customer', value: 'customer-5b992ae7-portal' },
      { key: 'platform', value: 'web' },
      { key: 'operator', value: 'US' },
      { key: 'segment', value: 'commercial_narrowbody' },
      { key: 'screen', value: 'inquiry' },
      { key: 'action', value: 'submit_inquiry' },
      { key: 'scenario', value: 'technical-inquiry' },
    ]));

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = Sentry.captureException.mock.calls[0];
    expect(captured.name).toBe('TypeError');
    expect(context.tags.service).toBe('customer-5b992ae7-portal');
  });

  test('the portal directive requires web reproduction, three native children, one commit, and a hosted refresh', () => {
    expect(PORTAL_REMEDIATION_DIRECTIVE).toContain('devindemos.com/5b992ae7/app');
    expect(PORTAL_REMEDIATION_DIRECTIVE).toMatch(/Reproduce on web first/);
    expect(PORTAL_REMEDIATION_DIRECTIVE).toMatch(/Linux, Windows and macOS/);
    expect(PORTAL_REMEDIATION_DIRECTIVE).toMatch(/SAME commit SHA/);
    expect(PORTAL_REMEDIATION_DIRECTIVE).toContain('app/public/verticals/5b992ae7-app/');
    expect(PORTAL_REMEDIATION_DIRECTIVE).toContain('canvaskit/');
    expect(PORTAL_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
  });

  describe('POST /api/5b992ae7/portal/error', () => {
    let server;

    beforeAll((done) => {
      const app = express();
      app.use(express.json());
      app.use(router);
      server = app.listen(0, done);
    });

    afterAll((done) => {
      server.close(done);
    });

    test('accepts a portal report with 202 and a reference', async () => {
      const { status, body } = await postJson(server, '/api/5b992ae7/portal/error', PORTAL_REPORT);

      expect(status).toBe(202);
      expect(body).toMatchObject({
        received: true,
        service: 'customer-5b992ae7-portal',
        sessionRequested: true,
      });
      expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects reports that do not carry the portal identity', async () => {
      const { status, body } = await postJson(server, '/api/5b992ae7/portal/error', {
        ...PORTAL_REPORT,
        service: 'customer-5b992ae7-inquiry',
      });

      expect(status).toBe(400);
      expect(body.received).toBe(false);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });
  });
});
