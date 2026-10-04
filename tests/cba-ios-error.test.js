jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: {
    captureException: jest.fn(),
    withScope: jest.fn((callback) => {
      const scope = { setTransactionName: jest.fn(), addEventProcessor: jest.fn() };
      callback(scope);
      return scope;
    }),
  },
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
const { incrementMetric } = require('../app/telemetry/datadog');
const {
  APP_CULPRIT,
  APP_FLUTTER_CULPRIT,
  APP_FLUTTER_RELEASE_PREFIX,
  APP_WEB_PATH,
  APP_PROJECT,
  APP_REMEDIATION_DIRECTIVE,
  APP_RELEASE,
  APP_SCENARIO,
  APP_SERVICE,
  APP_SOURCE_PREFIX,
  IOS_ERROR_PATH,
  isAppReport,
  reportAppFailure,
} = require('../app/services/verticals/cba-ios');
const router = require('../app/routes/verticals/cba');
const {
  applyCustomerIdentity,
  extractAlertData,
  isInstantPathEvent,
} = require('../app/routes/sentry-webhook');

const ORG_ID = 'org_69IXJFLrljx8zSAw';

const APP_REPORT = {
  source: `${APP_SOURCE_PREFIX}ios`,
  service: APP_SERVICE,
  release: APP_RELEASE,
  environment: 'prod',
  platform: 'ios',
  screen: 'pay_anyone',
  action: 'pay_now',
  reference: 'NB-ERR-7C21E9',
  paymentMethod: 'payid',
  payIdType: 'abn',
  payId: '54 692 411 003',
  payeeName: 'Sunrise Plumbing Pty Ltd',
  fromAccount: '062-000 10345678',
  accountProduct: 'smart_access',
  amount: 1480,
  description: 'Invoice 80114',
  device: 'iPhone',
  osVersion: 'iOS 26.5',
  appVersion: '1.0.0',
  errorType: 'PaymentAddressingError.unregisteredPayIdType',
  errorMessage: 'No NPP addressing profile registered for PayID type abn',
  stackTrace: [
    'NPPAddressingRegistry.profile(for:) (CommBankCore/Sources/CommBankCore/NPPAddressingProfiles.swift:48)',
    'PaymentService.pay(_:) (CommBankCore/Sources/CommBankCore/PaymentService.swift:33)',
  ].join('\n'),
  devinUserId: 'user-75c426edb9d1493084f757acf6bc8543',
  devinOrgId: ORG_ID,
  devinEmail: 'shubhra.ganguly@cognition.ai',
};

function postJson(server, path, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({
          status: res.statusCode,
          headers: res.headers,
          body: JSON.parse(data),
        }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

describe('CommBank iOS Pay anyone failure report', () => {
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

  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    Sentry.withScope.mockClear();
    incrementMetric.mockClear();
  });

  test('routes Flutter (web/iOS) reports to the Dart registry culprit with the same identity', async () => {
    const flutterReport = {
      ...APP_REPORT,
      source: `${APP_SOURCE_PREFIX}web`,
      platform: 'web',
      release: `${APP_FLUTTER_RELEASE_PREFIX}1.0.0`,
      device: 'Chrome',
    };
    const { status, body } = await postJson(server, IOS_ERROR_PATH, flutterReport);

    expect(status).toBe(202);
    expect(body.service).toBe(APP_SERVICE);

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData).toMatchObject({
      customer: 'cba',
      service: APP_SERVICE,
      verticalLabel: 'CommBank app — Pay anyone (web)',
      release: `${APP_FLUTTER_RELEASE_PREFIX}1.0.0`,
      culprit: APP_FLUTTER_CULPRIT,
      devinUserId: APP_REPORT.devinUserId,
      devinOrgId: ORG_ID,
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'platform', value: 'web' },
      { key: 'service', value: APP_SERVICE },
    ]));
    expect(APP_REMEDIATION_DIRECTIVE).toContain('CommBankApp/lib/core/npp_addressing_profiles.dart');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('NPPAddressingProfiles.swift');
    expect(APP_REMEDIATION_DIRECTIVE).toContain(APP_WEB_PATH);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('CBA_DISABLE_FAILURE_REPORTS=1');
  });

  test('accepts a valid app report and forwards the client identity', async () => {
    const { status, body } = await postJson(server, IOS_ERROR_PATH, APP_REPORT);

    expect(status).toBe(202);
    expect(body).toMatchObject({
      received: true,
      status: 'accepted',
      service: APP_SERVICE,
      sessionRequested: true,
    });
    expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData).toMatchObject({
      customer: 'cba',
      service: APP_SERVICE,
      verticalLabel: 'CommBank app — Pay anyone (ios)',
      project: APP_PROJECT,
      release: APP_RELEASE,
      culprit: APP_CULPRIT,
      errorType: APP_REPORT.errorType,
      devinUserId: APP_REPORT.devinUserId,
      devinOrgId: ORG_ID,
      devinEmail: APP_REPORT.devinEmail,
      slackMemberId: '',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: IOS_ERROR_PATH },
      { key: 'service', value: APP_SERVICE },
      { key: 'customer', value: APP_SERVICE },
      { key: 'payment_method', value: 'payid' },
      { key: 'payid_type', value: 'abn' },
      { key: 'account_product', value: 'smart_access' },
      { key: 'scenario', value: APP_SCENARIO },
      { key: 'alert_path', value: 'instant' },
    ]));
    expect(alertData.extra).toMatchObject({
      clientReference: 'NB-ERR-7C21E9',
      payeeName: APP_REPORT.payeeName,
      fromAccount: APP_REPORT.fromAccount,
      amount: 1480,
    });
    expect(incrementMetric).toHaveBeenCalledWith('cba.ios.payment.failure', expect.objectContaining({
      route: IOS_ERROR_PATH,
      payIdType: 'abn',
      paymentMethod: 'payid',
    }));
  });

  test('captures the app error with the instant-path transaction and tags', () => {
    reportAppFailure(APP_REPORT);

    const scope = Sentry.withScope.mock.results[0].value;
    expect(scope.setTransactionName).toHaveBeenCalledWith(`POST ${IOS_ERROR_PATH}`);
    const processor = scope.addEventProcessor.mock.calls[0][0];
    expect(processor({ release: 'acme-checkout@1.0.0', environment: 'staging' })).toMatchObject({
      release: APP_RELEASE,
      environment: 'prod',
    });
    const [error, context] = Sentry.captureException.mock.calls[0];
    expect(error.name).toBe(APP_REPORT.errorType);
    expect(error.stack).toContain('NPPAddressingProfiles.swift');
    expect(context.tags).toMatchObject({
      route: IOS_ERROR_PATH,
      service: APP_SERVICE,
      customer: APP_SERVICE,
      scenario: APP_SCENARIO,
      alert_path: 'instant',
    });
  });

  test('never hard-codes an on-call member when no email is forwarded', () => {
    const report = { ...APP_REPORT };
    delete report.devinEmail;

    reportAppFailure(report);

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinUserId).toBe(report.devinUserId);
    expect(alertData.devinEmail).toBeUndefined();
    expect(alertData.slackMemberId).toBe('');
    expect(alertData.slackMemberIdFallback).toBe(process.env.CBA_SLACK_MEMBER_ID || '');
  });

  test('isAppReport requires both the CommBank source prefix and service', () => {
    expect(isAppReport(APP_REPORT)).toBe(true);
    expect(isAppReport({ ...APP_REPORT, source: 'westpac-mobile/ios' })).toBe(false);
    expect(isAppReport({ ...APP_REPORT, service: 'customer-cba-payment' })).toBe(false);
    expect(isAppReport({})).toBe(false);
    expect(isAppReport(null)).toBe(false);
  });

  test('rejects foreign, missing, and wrong-service reports without alerting', async () => {
    for (const report of [
      { ...APP_REPORT, source: 'westpac-mobile/ios' },
      { ...APP_REPORT, service: 'customer-cba-payment' },
      {},
    ]) {
      const { status, body, headers } = await postJson(server, IOS_ERROR_PATH, report);
      expect(status).toBe(400);
      expect(body).toMatchObject({ received: false, status: 'rejected' });
      expect(headers['access-control-allow-origin']).toBe('*');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('answers the CORS preflight', async () => {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}${IOS_ERROR_PATH}`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:8080', 'access-control-request-method': 'POST' },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
  });

  test('throttles accepted reports after the per-route cap', async () => {
    const { reserveReportSlot, retryAfterSeconds } = require('../app/routes/verticals/cba');
    const now = Date.now();
    while (reserveReportSlot(now)) { /* fill the window */ }

    const { status, headers, body } = await postJson(server, IOS_ERROR_PATH, APP_REPORT);
    expect(status).toBe(429);
    const retryAfter = Number(headers['retry-after']);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(600);
    expect(body).toMatchObject({ received: false, status: 'throttled' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    // Retry-After tracks the oldest accepted slot, not the full window.
    expect(retryAfterSeconds(now + 9 * 60 * 1000)).toBe(60);
    expect(reserveReportSlot(now + 11 * 60 * 1000)).toBe(true);
  });

  test('keeps the NetBank web payment route unchanged', async () => {
    const { status, body } = await postJson(server, '/api/cba/payment', {});

    expect(status).toBe(500);
    expect(body).toMatchObject({ success: false, errorClass: 'TypeError' });
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.service).toBe('customer-cba-payment');
  });

  test('keeps CommBank iOS and NetBank web customer identities separate', () => {
    const appAlert = applyCustomerIdentity({
      issueTitle: APP_REPORT.errorMessage,
      culprit: `POST ${IOS_ERROR_PATH}`,
      tags: [['service', APP_SERVICE]],
    });
    expect(appAlert).toMatchObject({
      customer: 'cba',
      verticalLabel: 'CommBank app (Flutter web/iOS + native iOS)',
      service: APP_SERVICE,
      project: APP_PROJECT,
      release: APP_RELEASE,
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(appAlert.tags).toEqual(expect.arrayContaining([
      { key: 'customer', value: APP_SERVICE },
      { key: 'scenario', value: APP_SCENARIO },
    ]));

    const webAlert = applyCustomerIdentity({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'directoryService')",
      culprit: 'app/services/verticals/cba.js — settlePayment',
      tags: [['service', 'customer-cba-payment']],
    });
    expect(webAlert.service).toBeUndefined();
    expect(webAlert.promptAppendix).toBeUndefined();
  });

  test('keeps the Flutter release on webhook-created alerts and falls back to the native release', () => {
    const base = {
      issueTitle: APP_REPORT.errorMessage,
      culprit: APP_FLUTTER_CULPRIT,
      tags: [['service', APP_SERVICE]],
    };
    const flutterRelease = `${APP_FLUTTER_RELEASE_PREFIX}1.0.0`;
    expect(applyCustomerIdentity({ ...base, release: flutterRelease }).release).toBe(flutterRelease);
    expect(applyCustomerIdentity({ ...base, release: '' }).release).toBe(APP_RELEASE);
    expect(applyCustomerIdentity(base).release).toBe(APP_RELEASE);
  });

  test('issue webhooks with a string Flutter release keep it through extraction and identity', () => {
    const flutterRelease = `${APP_FLUTTER_RELEASE_PREFIX}1.0.0`;
    const payload = (release) => ({
      action: 'created',
      data: {
        issue: {
          id: 'cba-ios-2',
          title: APP_REPORT.errorMessage,
          culprit: 'confirmPayment (CommBankApp/lib/app_model.dart)',
          metadata: { type: APP_REPORT.errorType, value: APP_REPORT.errorMessage },
        },
        event: { release, tags: [['service', APP_SERVICE]] },
      },
    });
    expect(applyCustomerIdentity(extractAlertData(payload(flutterRelease))).release).toBe(flutterRelease);
    expect(applyCustomerIdentity(extractAlertData(payload({ version: flutterRelease }))).release).toBe(flutterRelease);
    expect(applyCustomerIdentity(extractAlertData(payload(undefined))).release).toBe(APP_RELEASE);
  });

  test('recognizes a tagless Flutter issue webhook by its Dart culprit', () => {
    expect(isInstantPathEvent({ culprit: APP_FLUTTER_CULPRIT, tags: [] })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'profileFor (CommBankApp/lib/core/npp_addressing_profiles.dart)', tags: [] })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'settlePayment (app/services/verticals/cba.js)', tags: [] })).toBe(false);
  });

  test('recognizes the iOS instant path from transaction culprit and tag', () => {
    expect(isInstantPathEvent({
      issueTitle: APP_REPORT.errorMessage,
      culprit: `POST ${IOS_ERROR_PATH}`,
      tags: [],
    })).toBe(true);
    expect(isInstantPathEvent({
      issueTitle: APP_REPORT.errorMessage,
      culprit: APP_CULPRIT,
      tags: [['service', APP_SERVICE], ['alert_path', 'instant']],
    })).toBe(true);
    // Tagless issue webhooks whose culprit is the Swift stack frame must not re-alert.
    expect(isInstantPathEvent({ issueTitle: APP_REPORT.errorMessage, culprit: APP_CULPRIT, tags: [] })).toBe(true);
    expect(isInstantPathEvent({
      issueTitle: APP_REPORT.errorMessage,
      culprit: 'NPPAddressingRegistry.profile(for:)',
      tags: [],
    })).toBe(true);

    const alertData = extractAlertData({
      action: 'created',
      data: {
        issue: {
          id: 'cba-ios-1',
          title: APP_REPORT.errorMessage,
          culprit: `POST ${IOS_ERROR_PATH}`,
          metadata: { type: APP_REPORT.errorType, value: APP_REPORT.errorMessage },
        },
      },
    });
    expect(isInstantPathEvent(alertData)).toBe(true);
  });

  test('directive names the Swift repo, the simulator repro, and reporting-off safety', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('github.com/COG-GTM/event-driven-ios');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('make generate && make test-commbank');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('make run-commbank');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('CBA_DISABLE_FAILURE_REPORTS=1');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('NPPAddressingProfiles.swift');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('PaymentAddressingError.unregisteredPayIdType');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('recording');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('app/services/verticals/cba.js');
  });
});
