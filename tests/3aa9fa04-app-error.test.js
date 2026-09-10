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
  reportAppFailure,
  APP_REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/3aa9fa04');
const router = require('../app/routes/verticals/3aa9fa04');
const { getCustomerConfig } = require('../config/customers');

const APP_REPORT = {
  source: 'splash-sports-mobile/android',
  service: 'customer-3aa9fa04-mobile',
  release: 'splash-sports-mobile@1.0.0',
  environment: 'prod',
  platform: 'android',
  errorType: 'TypeError',
  errorMessage: "Cannot read properties of undefined (reading 'multiplier')",
  stackTrace: 'primetimeBoost (src/lib/payout.ts:24)\nsubmitSlip (src/state/AppState.tsx:41)',
  culprit: 'src/lib/payout.ts \u2014 primetimeBoost',
  screen: 'entry-slip',
  action: 'submit_entry',
  slate: 'MNF',
  game: 'DET @ GB',
  extra: { fee: 20, pickCount: 2 },
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

describe('Splash Sports mobile failure report (3aa9fa04)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('customer config targets the COG-GTM org', () => {
    const config = getCustomerConfig('3aa9fa04');
    expect(config.label).toBe('Splash Sports');
    expect(config.githubOrg).toBe('COG-GTM');
    expect(config.triggerMode).toBe('api');
  });

  test('reportAppFailure raises the alert under the mobile identity with slate context', () => {
    const { reference } = reportAppFailure(APP_REPORT);

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];

    expect(alertData).toMatchObject({
      customer: '3aa9fa04',
      service: 'customer-3aa9fa04-mobile',
      verticalLabel: 'Splash Sports Mobile',
      project: 'splash-sports-mobile',
      release: 'splash-sports-mobile@1.0.0',
      platform: 'android',
      errorType: 'TypeError',
      errorValue: "Cannot read properties of undefined (reading 'multiplier')",
      culprit: 'src/lib/payout.ts \u2014 primetimeBoost',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'service', value: 'customer-3aa9fa04-mobile' },
      { key: 'platform', value: 'android' },
      { key: 'screen', value: 'entry-slip' },
      { key: 'action', value: 'submit_entry' },
      { key: 'slate', value: 'MNF' },
      { key: 'game', value: 'DET @ GB' },
      { key: 'scenario', value: 'nfl-primetime-entry' },
    ]));
    expect(alertData.extra).toMatchObject({ fee: 20, pickCount: 2 });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = Sentry.captureException.mock.calls[0];
    expect(captured.name).toBe('TypeError');
    expect(context.tags.service).toBe('customer-3aa9fa04-mobile');
  });

  test('the directive names the Splash repo, requires reproduction + regression test, and stops before merge', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('COG-GTM/splash-sports-mobile');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/Reproduce first/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('src/lib/__tests__/');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('npm run build:web');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human review');
  });

  describe('POST /api/3aa9fa04/app/error', () => {
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

    test('accepts an app report with 202 and a reference', async () => {
      const { status, body } = await postJson(server, '/api/3aa9fa04/app/error', APP_REPORT);

      expect(status).toBe(202);
      expect(body).toMatchObject({
        received: true,
        service: 'customer-3aa9fa04-mobile',
        sessionRequested: true,
      });
      expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects reports that do not carry the mobile identity', async () => {
      const { status, body } = await postJson(server, '/api/3aa9fa04/app/error', {
        ...APP_REPORT,
        source: 'ge-customer-portal/web',
      });

      expect(status).toBe(400);
      expect(body.received).toBe(false);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });
  });
});
