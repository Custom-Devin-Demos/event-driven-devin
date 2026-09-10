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
} = require('../app/services/verticals/67f2a7ba');
const router = require('../app/routes/verticals/67f2a7ba');
const { getCustomerConfig } = require('../config/customers');
const { applyCustomerIdentity } = require('../app/routes/sentry-webhook');

const APP_REPORT = {
  source: 'citi-mobile/web',
  service: 'customer-67f2a7ba-mobile',
  release: 'citi-mobile@1.0.0',
  environment: 'prod',
  platform: 'web',
  errorType: '_TypeError',
  errorMessage: 'Null check operator used on a null value',
  stackTrace: 'buildPaymentSchedule (lib/domain/payment_schedule.dart:31)\nbuildPaymentConfirmation (lib/domain/payment_confirmation.dart:18)',
  screen: 'pay_card',
  action: 'make_payment',
  product: 'strata_elite',
  sentryEventId: 'a1b2c3',
  devinUserId: 'user-abc',
  devinOrgId: 'org-8e9e23dde2f340a780125d9a523f8b30',
  devinEmail: 'hub.user@example.com',
  payment: {
    card: 'card-strata-5521',
    fundingAccount: 'chk-0417',
    amountOption: 'minimum',
    scheduledFor: '2026-09-12T00:00:00.000',
    nested: { deep: true },
  },
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

describe('Citi mobile failure report (67f2a7ba)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('customer config is separate from Citi Self Invest and targets Custom-Devin-Demos', () => {
    const config = getCustomerConfig('67f2a7ba');
    expect(config.label).toBe('Citi Mobile');
    expect(config.githubOrg).toBe('Custom-Devin-Demos');
    expect(config.triggerMode).toBe('api');
    expect(getCustomerConfig('94f4c31f').label).toBe('Citi Self Invest');
  });

  test('reportAppFailure raises the alert under the mobile identity with the hub-selected user', () => {
    const { reference } = reportAppFailure(APP_REPORT);

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];

    expect(alertData).toMatchObject({
      customer: '67f2a7ba',
      service: 'customer-67f2a7ba-mobile',
      verticalLabel: 'Citi Mobile',
      project: 'citi-mobile',
      release: 'citi-mobile@1.0.0',
      platform: 'web',
      errorType: '_TypeError',
      errorValue: 'Null check operator used on a null value',
      culprit: 'lib/domain/payment_schedule.dart \u2014 buildPaymentSchedule',
      devinUserId: 'user-abc',
      devinOrgId: 'org-8e9e23dde2f340a780125d9a523f8b30',
      devinEmail: 'hub.user@example.com',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'service', value: 'customer-67f2a7ba-mobile' },
      { key: 'platform', value: 'web' },
      { key: 'screen', value: 'pay_card' },
      { key: 'action', value: 'make_payment' },
      { key: 'product', value: 'strata_elite' },
      { key: 'scenario', value: 'pay-citi-card' },
    ]));
    expect(alertData.extra.reference).toBe(reference);
    expect(alertData.extra.sentryEventId).toBe('a1b2c3');
    expect(alertData.extra.payment).toEqual({
      card: 'card-strata-5521',
      fundingAccount: 'chk-0417',
      amountOption: 'minimum',
      scheduledFor: '2026-09-12T00:00:00.000',
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = Sentry.captureException.mock.calls[0];
    expect(captured.name).toBe('_TypeError');
    expect(context.tags.service).toBe('customer-67f2a7ba-mobile');
  });

  test('does not default the Devin identity when the client sends none', () => {
    const anonymous = { ...APP_REPORT };
    delete anonymous.devinUserId;
    delete anonymous.devinOrgId;
    delete anonymous.devinEmail;
    reportAppFailure(anonymous);
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinUserId).toBeUndefined();
    expect(alertData.devinOrgId).toBeUndefined();
    expect(alertData.devinEmail).toBeUndefined();
  });

  test('the directive names the Flutter repo, all three surfaces, and stops before merge', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('Custom-Devin-Demos/citi-banking-demo-app');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/Reproduce on web first/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('test/domain/payment_posting_test.dart');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('scripts/verify-native.sh android');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('scripts/verify-native.sh ios');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('SAME commit SHA');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('app/public/verticals/67f2a7ba-app/');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
  });

  test('Sentry webhook maps the mobile service tag to the Citi Mobile identity', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: '_TypeError: Null check operator used on a null value',
      culprit: 'buildPaymentSchedule',
      tags: [
        ['service', 'customer-67f2a7ba-mobile'],
        ['platform', 'ios'],
      ],
    });

    expect(alertData).toMatchObject({
      customer: '67f2a7ba',
      verticalLabel: 'Citi Mobile',
      service: 'customer-67f2a7ba-mobile',
      project: 'citi-mobile',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'scenario', value: 'pay-citi-card' },
      ['platform', 'ios'],
    ]));
  });

  describe('HTTP routes', () => {
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

    test('POST /api/67f2a7ba/mobile/error accepts an app report with 202 and a reference', async () => {
      const { status, body } = await postJson(server, '/api/67f2a7ba/mobile/error', APP_REPORT);

      expect(status).toBe(202);
      expect(body).toMatchObject({
        received: true,
        service: 'customer-67f2a7ba-mobile',
        sessionRequested: true,
      });
      expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects reports that do not carry the Citi mobile identity', async () => {
      const { status, body } = await postJson(server, '/api/67f2a7ba/mobile/error', {
        ...APP_REPORT,
        source: 'ge-customer-portal/web',
      });

      expect(status).toBe(400);
      expect(body.received).toBe(false);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('POST /api/67f2a7ba/payments registers a scheduled payment without alerting', async () => {
      const { status, body } = await postJson(server, '/api/67f2a7ba/payments', {
        source: 'citi-mobile/android',
        product: 'custom_cash',
        amount: 35,
        confirmationNumber: 'CITI-1234',
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, confirmationNumber: 'CITI-1234', status: 'registered' });
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('answers the CORS preflight for dev builds on another origin', async () => {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/67f2a7ba/mobile/error`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:8080', 'access-control-request-method': 'POST' },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('redirects the friendly entry points to the hosted web build', async () => {
      const { port } = server.address();
      for (const entry of ['/67f2a7ba', '/citimobile']) {
        const res = await fetch(`http://127.0.0.1:${port}${entry}`, { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/67f2a7ba/app/');
      }
    });
  });
});
