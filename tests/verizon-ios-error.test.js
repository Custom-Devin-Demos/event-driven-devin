jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: {
    captureException: jest.fn(),
    withScope: jest.fn((callback) => {
      const scope = { setTransactionName: jest.fn() };
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
  APP_PROJECT,
  APP_REMEDIATION_DIRECTIVE,
  APP_RELEASE,
  APP_REPO,
  APP_SCENARIO,
  APP_SERVICE,
  APP_SOURCE_PREFIX,
  IOS_ERROR_PATH,
  isAppReport,
  reportAppFailure,
} = require('../app/services/verticals/verizon-ios');
const router = require('../app/routes/verticals/verizon-ios');
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
  screen: 'checkout_review',
  action: 'place_order',
  device: 'iPhone 18 Pro',
  osVersion: 'iOS 27.0',
  appVersion: '12.4.1',
  errorType: 'OrderError.unknownLineItem',
  errorMessage: "Order line 'PROMO-IP18-LAUNCH' is not a catalog product and could not be added to the receipt",
  stackTrace: [
    'ReceiptFormatter.receiptLine(_:) (MyVerizonCore/Sources/MyVerizonCore/Checkout/ReceiptFormatter.swift:64)',
    'CheckoutReviewViewModel.placeOrder (MyVerizon/Features/Checkout/CheckoutReviewViewModel.swift:118)',
  ].join('\n'),
  deviceSku: 'APL-IP18-PRO-256',
  deviceName: 'iPhone 18 Pro',
  storage: '256 GB',
  color: 'Midnight',
  planId: 'PLN-UNL-ULTIMATE',
  perks: 'PRK-DISNEY-BUNDLE',
  tradeInDevice: 'iPhone 16 Pro',
  lineId: 'L1',
  orderNumber: 'VZ123456',
  devinUserId: '',
  devinEmail: 'antonio.ruiz@cognition.ai',
  devinOrgId: ORG_ID,
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

describe('My Verizon iOS preorder failure report', () => {
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

  test('accepts a valid app report with client-forwarded identity', async () => {
    const { status, body } = await postJson(server, IOS_ERROR_PATH, APP_REPORT);

    expect(status).toBe(202);
    expect(body).toMatchObject({
      received: true,
      status: 'accepted',
      service: APP_SERVICE,
      sessionRequested: true,
    });
    expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData).toMatchObject({
      customer: '4e150e99',
      service: APP_SERVICE,
      verticalLabel: 'My Verizon — iPhone 18 Preorder (iOS)',
      project: APP_PROJECT,
      release: APP_RELEASE,
      issueTitle: `${APP_REPORT.errorType}: ${APP_REPORT.errorMessage}`,
      culprit: 'my-verizon/ios checkout_review place_order',
      devinUserId: '',
      devinOrgId: ORG_ID,
      devinEmail: APP_REPORT.devinEmail,
      slackMemberId: '',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.slackChannelId).toBeUndefined();
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: IOS_ERROR_PATH },
      { key: 'service', value: APP_SERVICE },
      { key: 'customer', value: APP_SERVICE },
      { key: 'device_sku', value: APP_REPORT.deviceSku },
      { key: 'plan_id', value: APP_REPORT.planId },
      { key: 'scenario', value: APP_SCENARIO },
      { key: 'alert_path', value: 'instant' },
    ]));
    expect(alertData.extra).toMatchObject({
      deviceSku: APP_REPORT.deviceSku,
      deviceName: APP_REPORT.deviceName,
      storage: APP_REPORT.storage,
      color: APP_REPORT.color,
      planId: APP_REPORT.planId,
      perks: APP_REPORT.perks,
      tradeInDevice: APP_REPORT.tradeInDevice,
      lineId: APP_REPORT.lineId,
      orderNumber: APP_REPORT.orderNumber,
      reporterEmail: APP_REPORT.devinEmail,
    });
    expect(incrementMetric).toHaveBeenCalledWith('preorder.ios.failure', expect.objectContaining({
      route: IOS_ERROR_PATH,
      errorClass: APP_REPORT.errorType,
      deviceSku: APP_REPORT.deviceSku,
      planId: APP_REPORT.planId,
    }));
  });

  test('captures the app error with the instant-path transaction and tags', () => {
    reportAppFailure(APP_REPORT);

    expect(Sentry.withScope).toHaveBeenCalledTimes(1);
    const scope = Sentry.withScope.mock.results[0].value;
    expect(scope.setTransactionName).toHaveBeenCalledWith(`POST ${IOS_ERROR_PATH}`);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, context] = Sentry.captureException.mock.calls[0];

    expect(error.name).toBe(APP_REPORT.errorType);
    expect(error.message).toBe(APP_REPORT.errorMessage);
    expect(context.tags).toMatchObject({
      route: IOS_ERROR_PATH,
      service: APP_SERVICE,
      customer: APP_SERVICE,
      device_sku: APP_REPORT.deviceSku,
      scenario: APP_SCENARIO,
      alert_path: 'instant',
    });
    expect(context.extra).toMatchObject({
      orderNumber: APP_REPORT.orderNumber,
      tradeInDevice: APP_REPORT.tradeInDevice,
    });
  });

  test('clips oversized strings before they reach Sentry and the alert', () => {
    reportAppFailure({
      ...APP_REPORT,
      errorMessage: 'x'.repeat(600),
      stackTrace: 'y'.repeat(5000),
      perks: 'z'.repeat(300),
    });

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.errorValue).toHaveLength(512);
    expect(alertData.extra.stackTrace).toHaveLength(4000);
    expect(alertData.extra.perks).toHaveLength(256);
  });

  test('falls back to the configured Slack member when no email is forwarded', () => {
    const report = { ...APP_REPORT };
    delete report.devinEmail;

    reportAppFailure(report);

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinUserId).toBe(report.devinUserId);
    expect(alertData.devinOrgId).toBe(report.devinOrgId);
    expect(alertData.devinEmail).toBeUndefined();
    expect(alertData.slackMemberId).toBe(process.env.VERIZON_SLACK_MEMBER_ID || '');
    expect(alertData.slackMemberIdFallback).toBe(process.env.VERIZON_SLACK_MEMBER_ID || '');
  });

  test('isAppReport requires both the My Verizon source prefix and service', () => {
    expect(isAppReport(APP_REPORT)).toBe(true);
    expect(isAppReport({ ...APP_REPORT, source: 'my-verizon/android' })).toBe(true);
    expect(isAppReport({ ...APP_REPORT, source: 'westpac-mobile/ios' })).toBe(false);
    expect(isAppReport({ ...APP_REPORT, service: 'verizon-ecommerce' })).toBe(false);
    expect(isAppReport({})).toBe(false);
    expect(isAppReport(null)).toBe(false);
  });

  test('rejects foreign, missing, and wrong-service reports without alerting', async () => {
    for (const report of [
      { ...APP_REPORT, source: 'other-app/ios' },
      { ...APP_REPORT, service: 'verizon-ecommerce' },
      {},
    ]) {
      const { status, body } = await postJson(server, IOS_ERROR_PATH, report);
      expect(status).toBe(400);
      expect(body).toMatchObject({ received: false, status: 'rejected' });
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
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  test('POST /api/verizon/ios/error includes CORS headers on rejection', async () => {
    const { status, headers } = await postJson(server, IOS_ERROR_PATH, {});

    expect(status).toBe(400);
    expect(headers['access-control-allow-origin']).toBe('*');
  });

  test('throttles accepted reports after the per-route cap', async () => {
    const { reserveReportSlot } = require('../app/routes/verticals/verizon-ios');
    const now = Date.now();
    while (reserveReportSlot(now)) { /* fill the window */ }

    const { status, headers, body } = await postJson(server, IOS_ERROR_PATH, APP_REPORT);
    expect(status).toBe(429);
    expect(headers['retry-after']).toBe('600');
    expect(body).toMatchObject({ received: false, status: 'throttled' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(reserveReportSlot(now + 11 * 60 * 1000)).toBe(true);
  });

  test('applies the verizon-ios identity to webhook alerts carrying the iOS service', () => {
    const appAlert = applyCustomerIdentity({
      issueTitle: APP_REPORT.errorMessage,
      culprit: `POST ${IOS_ERROR_PATH}`,
      tags: [['service', APP_SERVICE]],
    });
    expect(appAlert).toMatchObject({
      customer: '4e150e99',
      verticalLabel: 'My Verizon — iPhone 18 Preorder (iOS)',
      service: APP_SERVICE,
      project: APP_PROJECT,
      release: APP_RELEASE,
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(appAlert.slackChannelId).toBeUndefined();
    expect(appAlert.tags).toEqual(expect.arrayContaining([
      { key: 'customer', value: APP_SERVICE },
      { key: 'service', value: APP_SERVICE },
      { key: 'scenario', value: APP_SCENARIO },
    ]));

    const webAlert = applyCustomerIdentity({
      issueTitle: 'TypeError: formatReceipt',
      culprit: 'app/services/verticals/4e150e99.js — formatReceipt',
      tags: [['service', 'verizon-ecommerce']],
    });
    expect(webAlert.service).toBeUndefined();
    expect(webAlert.promptAppendix).toBeUndefined();
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

    const alertData = extractAlertData({
      action: 'created',
      data: {
        issue: {
          id: 'verizon-ios-1',
          title: APP_REPORT.errorMessage,
          culprit: `POST ${IOS_ERROR_PATH}`,
          metadata: {
            type: APP_REPORT.errorType,
            value: APP_REPORT.errorMessage,
          },
        },
      },
    });
    expect(alertData.tags).toEqual([]);
    expect(isInstantPathEvent(alertData)).toBe(true);
  });

  test('directive names the external Swift repo and reporting-off reproduction', () => {
    expect(APP_REPO).toBe('github.com/COG-GTM/demo-verizon-ios');
    expect(APP_REMEDIATION_DIRECTIVE).toContain(APP_REPO);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('ReceiptFormatter.swift');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('OrderPricing.swift');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('DeviceCatalog.swift');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('PROMO-IP18-LAUNCH');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('OrderError.unknownLineItem');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('swift test --package-path MyVerizonCore');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('MYVZ_DISABLE_FAILURE_REPORTS=1');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
    expect(APP_REMEDIATION_DIRECTIVE).not.toContain('4e150e99.js —');
  });
});
