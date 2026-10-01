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
  APP_SCENARIO,
  APP_SERVICE,
  APP_SOURCE_PREFIX,
  IOS_ERROR_PATH,
  isAppReport,
  reportAppFailure,
  submitDispute,
} = require('../app/services/verticals/westpac');
const router = require('../app/routes/verticals/westpac');
const {
  applyCustomerIdentity,
  extractAlertData,
  isInstantPathEvent,
} = require('../app/routes/sentry-webhook');

const ORG_ID = 'org-westpac-demo';

const APP_REPORT = {
  source: `${APP_SOURCE_PREFIX}ios`,
  service: APP_SERVICE,
  release: APP_RELEASE,
  environment: 'prod',
  platform: 'ios',
  screen: 'dispute_form',
  action: 'lodge_dispute',
  cardProduct: 'westpac_altitude_black_mastercard',
  cardAccountNumber: 'WBC-CC-4417-2280',
  disputeReason: 'unauthorised',
  merchantName: 'LUMA TRAVEL SERVICES PTY LTD',
  transactionAmount: 2480.75,
  device: 'iPhone 16 Pro',
  osVersion: 'iOS 18.6',
  appVersion: '1.0.0',
  errorType: 'DisputeSchemeError.unregisteredProduct',
  errorMessage: 'No dispute scheme rules registered for westpac_altitude_black_mastercard',
  stackTrace: [
    'DisputeSchemeRegistry.rules(for:) (WestpacCore/Sources/WestpacCore/DisputeSchemeRules.swift:88)',
    'DisputeFormViewModel.lodgeDispute (WestpacApp/Features/Dispute/DisputeFormViewModel.swift:142)',
  ].join('\n'),
  dispute: {
    cardPresent: false,
    contactedMerchant: true,
    cardLostOrStolen: false,
    contactNumber: '0438 662 105',
    description: 'I did not authorise this charge.',
    nested: { omitted: true },
  },
  sentryEventId: null,
  devinUserId: 'user-westpac-demo',
  devinOrgId: ORG_ID,
  devinEmail: 'presenter@westpac.example',
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

describe('Westpac Mobile iOS card-dispute failure report', () => {
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
      customer: 'westpac',
      service: APP_SERVICE,
      verticalLabel: 'Westpac Mobile — Card Dispute (iOS)',
      project: APP_PROJECT,
      release: APP_RELEASE,
      culprit: APP_CULPRIT,
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
      { key: 'card_product', value: APP_REPORT.cardProduct },
      { key: 'dispute_reason', value: APP_REPORT.disputeReason },
      { key: 'scenario', value: APP_SCENARIO },
      { key: 'alert_path', value: 'instant' },
    ]));
    expect(alertData.extra.dispute).toEqual({
      cardPresent: false,
      contactedMerchant: true,
      cardLostOrStolen: false,
      contactNumber: APP_REPORT.dispute.contactNumber,
      description: APP_REPORT.dispute.description,
    });
    expect(incrementMetric).toHaveBeenCalledWith('dispute.ios.failure', expect.objectContaining({
      route: IOS_ERROR_PATH,
      cardProduct: APP_REPORT.cardProduct,
      disputeReason: APP_REPORT.disputeReason,
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
    expect(context.tags).toMatchObject({
      route: IOS_ERROR_PATH,
      service: APP_SERVICE,
      customer: APP_SERVICE,
      scenario: APP_SCENARIO,
      alert_path: 'instant',
    });
  });

  test('falls back to the configured Slack member when no email is forwarded', () => {
    const report = { ...APP_REPORT };
    delete report.devinEmail;

    reportAppFailure(report);

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinUserId).toBe(report.devinUserId);
    expect(alertData.devinOrgId).toBe(report.devinOrgId);
    expect(alertData.devinEmail).toBeUndefined();
    expect(alertData.slackMemberId).toBe(process.env.WESTPAC_SLACK_MEMBER_ID || '');
    expect(alertData.slackMemberIdFallback).toBe(process.env.WESTPAC_SLACK_MEMBER_ID || '');
  });

  test('isAppReport requires both the Westpac source prefix and service', () => {
    expect(isAppReport(APP_REPORT)).toBe(true);
    expect(isAppReport({ ...APP_REPORT, source: 'westpac-mobile/android' })).toBe(true);
    expect(isAppReport({ ...APP_REPORT, source: 'other-app/ios' })).toBe(false);
    expect(isAppReport({ ...APP_REPORT, service: 'customer-westpac-disputes' })).toBe(false);
    expect(isAppReport({})).toBe(false);
    expect(isAppReport(null)).toBe(false);
  });

  test('rejects foreign, missing, and wrong-service reports without alerting', async () => {
    for (const report of [
      { ...APP_REPORT, source: 'other-app/ios' },
      { ...APP_REPORT, service: 'customer-westpac-disputes' },
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

  test('throttles accepted reports after the per-route cap', async () => {
    const { reserveReportSlot } = require('../app/routes/verticals/westpac');
    const now = Date.now();
    while (reserveReportSlot(now)) { /* fill the window */ }

    const { status, headers, body } = await postJson(server, IOS_ERROR_PATH, APP_REPORT);
    expect(status).toBe(429);
    expect(headers['retry-after']).toBe('600');
    expect(body).toMatchObject({ received: false, status: 'throttled' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(reserveReportSlot(now + 11 * 60 * 1000)).toBe(true);
  });

  test('keeps the web dispute route available for the default Altitude Black card', async () => {
    const { status, body } = await postJson(server, '/api/westpac/dispute', {});

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      status: 'accepted',
      cardAccountNumber: 'WBC-CC-4417-2280',
      scheme: 'Mastercard',
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('keeps Westpac iOS and web customer identities separate', () => {
    const appAlert = applyCustomerIdentity({
      issueTitle: APP_REPORT.errorMessage,
      culprit: `POST ${IOS_ERROR_PATH}`,
      tags: [['service', APP_SERVICE]],
    });
    expect(appAlert).toMatchObject({
      customer: 'westpac',
      verticalLabel: 'Westpac Mobile',
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
      issueTitle: 'TypeError: chargebackWindowDays',
      culprit: 'app/services/verticals/westpac.js — calculateDisputeOutcome',
      tags: [['service', 'customer-westpac-disputes']],
    });
    expect(webAlert.customer).not.toBe('westpac');
    expect(webAlert.service).toBeUndefined();
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
          id: 'westpac-ios-1',
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
    expect(APP_REMEDIATION_DIRECTIVE).toContain('github.com/COG-GTM/event-driven-ios');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('make generate && make test && make run-westpac');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('WBC_DISABLE_FAILURE_REPORTS=1');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('DisputeSchemeError.unregisteredProduct');
  });

  test('POST /api/westpac/ios/error includes CORS headers on rejection', async () => {
    const { status, headers } = await postJson(server, IOS_ERROR_PATH, {});

    expect(status).toBe(400);
    expect(headers['access-control-allow-origin']).toBe('*');
  });

  test('submitDispute remains available for the existing web vertical', async () => {
    await expect(submitDispute({
      cardAccountNumber: 'WBC-CC-9902-1147',
      disputeReason: 'unauthorised',
      merchantName: 'Example Merchant',
      transactionDate: '2026-09-18',
      transactionAmount: 100,
      description: 'Valid dispute',
      contactNumber: '0438 662 105',
      declaration: true,
    })).resolves.toMatchObject({
      success: true,
      status: 'accepted',
      scheme: 'Visa',
    });
  });
});
