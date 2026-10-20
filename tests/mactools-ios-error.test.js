jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/services/devin-api', () => ({
  listOrgUsers: jest.fn(() => Promise.resolve([])),
  listEnterpriseAdmins: jest.fn(() => Promise.resolve([])),
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
const { createSessionAndAlert } = require('../app/services/devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../app/services/devin-api');
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
  MACTOOLS_IOS_SESSION_PLATFORM,
  isAppReport,
  reportAppFailure,
  resolveUserIdByEmail,
} = require('../app/services/verticals/mactools-ios');
const router = require('../app/routes/verticals/mactools-ios');
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
  screen: 'payment_review',
  action: 'submit_weekly_payment',
  customerNumber: '300418772',
  shopName: "Delgado's Diesel & Auto Repair",
  accountId: 'EC-48817',
  accountType: 'Extended Credit',
  planCode: 'FLEX36',
  paymentAmount: '185',
  accounts: 'RA-300418772:RA:65,EC-48817:FLEX36:120',
  device: 'iPhone 18 Pro (Simulator)',
  osVersion: 'iOS 27.0',
  appVersion: '3.2.0',
  errorType: 'PaymentError.unmappedPlanCode',
  errorCode: 'MT-PAY-4221',
  errorMessage: 'No ledger allocation code for plan FLEX36 on account EC-48817.',
  stackTrace: [
    'WeeklyPaymentProcessor.allocate(_:across:) (MacToolsCore/Sources/MacToolsCore/WeeklyPayment.swift:118)',
    'MTAppModel.submitPayment() (MacToolsMobile/MacToolsMobileApp.swift:198)',
  ].join('\n'),
  devinUserId: '',
  devinEmail: 'matthew.guerra@cognition.ai',
  devinOrgId: ORG_ID,
};

async function postJson(server, path, body) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.json(),
  };
}

describe('Mac Tools AMP iOS weekly payment failure report', () => {
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
    listOrgUsers.mockReset();
    listOrgUsers.mockResolvedValue([]);
    listEnterpriseAdmins.mockReset();
    listEnterpriseAdmins.mockResolvedValue([]);
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

    await new Promise((resolve) => { setImmediate(resolve); });
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData).toMatchObject({
      customer: 'ios-demos',
      service: APP_SERVICE,
      verticalLabel: 'Mac Tools AMP — Weekly Payment (iOS)',
      project: APP_PROJECT,
      release: APP_RELEASE,
      issueTitle: `${APP_REPORT.errorType}: ${APP_REPORT.errorMessage}`,
      culprit: 'mactools-amp/ios payment_review submit_weekly_payment',
      devinOrgId: ORG_ID,
      devinEmail: APP_REPORT.devinEmail,
      slackMemberId: '',
      sessionPlatform: MACTOOLS_IOS_SESSION_PLATFORM || undefined,
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.slackChannelId).toBeUndefined();
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: IOS_ERROR_PATH },
      { key: 'service', value: APP_SERVICE },
      { key: 'customer', value: APP_SERVICE },
      { key: 'plan_code', value: 'FLEX36' },
      { key: 'error_code', value: 'MT-PAY-4221' },
      { key: 'scenario', value: APP_SCENARIO },
      { key: 'alert_path', value: 'instant' },
    ]));
    expect(alertData.extra).toMatchObject({
      customerNumber: '300418772',
      shopName: APP_REPORT.shopName,
      accountId: 'EC-48817',
      accountType: 'Extended Credit',
      planCode: 'FLEX36',
      paymentAmount: '185',
      accounts: APP_REPORT.accounts,
      errorCode: 'MT-PAY-4221',
      reporterEmail: APP_REPORT.devinEmail,
    });
    expect(incrementMetric).toHaveBeenCalledWith('payment.ios.failure', expect.objectContaining({
      route: IOS_ERROR_PATH,
      errorClass: APP_REPORT.errorType,
      planCode: 'FLEX36',
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
      plan_code: 'FLEX36',
      scenario: APP_SCENARIO,
      alert_path: 'instant',
    });
    expect(context.extra).toMatchObject({
      accountId: 'EC-48817',
      planCode: 'FLEX36',
    });
  });

  test('clips oversized strings before they reach Sentry and the alert', async () => {
    await reportAppFailure({
      ...APP_REPORT,
      errorMessage: 'x'.repeat(600),
      stackTrace: 'y'.repeat(5000),
      accounts: 'z'.repeat(600),
    }).sessionPromise;

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.sessionPlatform).toBe(MACTOOLS_IOS_SESSION_PLATFORM || undefined);
    expect(alertData.errorValue).toHaveLength(512);
    expect(alertData.extra.stackTrace).toHaveLength(4000);
    expect(alertData.extra.accounts).toHaveLength(512);
  });

  test('falls back to the configured Slack member when no email is forwarded', async () => {
    const report = { ...APP_REPORT };
    delete report.devinEmail;

    await reportAppFailure(report).sessionPromise;

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.sessionPlatform).toBe(MACTOOLS_IOS_SESSION_PLATFORM || undefined);
    expect(alertData.devinUserId).toBe(report.devinUserId);
    expect(alertData.devinOrgId).toBe(report.devinOrgId);
    expect(alertData.devinEmail).toBeUndefined();
    expect(alertData.slackMemberId).toBe(process.env.VERIZON_SLACK_MEMBER_ID || '');
    expect(alertData.slackMemberIdFallback).toBe(process.env.VERIZON_SLACK_MEMBER_ID || '');
  });

  test('creates the session as the reporter resolved from devinEmail', async () => {
    listOrgUsers.mockResolvedValue([
      { user_id: 'user-other', email: 'someone@cognition.ai' },
      { user_id: 'user-matthew', email: 'Matthew.Guerra@cognition.ai' },
    ]);

    await reportAppFailure(APP_REPORT).sessionPromise;

    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, expect.any(Object));
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('user-matthew');
    expect(createSessionAndAlert.mock.calls[0][0].sessionPlatform).toBe(MACTOOLS_IOS_SESSION_PLATFORM || undefined);
  });

  test('falls back to enterprise admins, then to the customer default user', async () => {
    listEnterpriseAdmins.mockResolvedValueOnce([{ user_id: 'user-admin', email: APP_REPORT.devinEmail }]);
    await reportAppFailure(APP_REPORT).sessionPromise;
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('user-admin');
    expect(createSessionAndAlert.mock.calls[0][0].sessionPlatform).toBe(MACTOOLS_IOS_SESSION_PLATFORM || undefined);

    await reportAppFailure(APP_REPORT).sessionPromise;
    expect(createSessionAndAlert.mock.calls[1][0].devinUserId).toBeUndefined();
    expect(createSessionAndAlert.mock.calls[1][0].sessionPlatform).toBe(MACTOOLS_IOS_SESSION_PLATFORM || undefined);
  });

  test('uses a forwarded devinUserId without looking up the email', async () => {
    await reportAppFailure({ ...APP_REPORT, devinUserId: 'user-explicit' }).sessionPromise;

    expect(listOrgUsers).not.toHaveBeenCalled();
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('user-explicit');
    expect(createSessionAndAlert.mock.calls[0][0].sessionPlatform).toBe(MACTOOLS_IOS_SESSION_PLATFORM || undefined);
  });

  test('resolveUserIdByEmail returns empty on missing input or lookup failure', async () => {
    expect(await resolveUserIdByEmail('', ORG_ID)).toBe('');
    expect(await resolveUserIdByEmail(APP_REPORT.devinEmail, '')).toBe('');
    listOrgUsers.mockRejectedValueOnce(new Error('boom'));
    expect(await resolveUserIdByEmail(APP_REPORT.devinEmail, ORG_ID)).toBe('');
  });

  test('isAppReport requires both the Mac Tools source prefix and service', () => {
    expect(isAppReport(APP_REPORT)).toBe(true);
    expect(isAppReport({ ...APP_REPORT, source: 'mactools-amp/android' })).toBe(true);
    expect(isAppReport({ ...APP_REPORT, source: 'westpac-mobile/ios' })).toBe(false);
    expect(isAppReport({ ...APP_REPORT, service: 'mactools-ecommerce' })).toBe(false);
    expect(isAppReport({})).toBe(false);
    expect(isAppReport(null)).toBe(false);
  });

  test('rejects foreign, missing, and wrong-service reports without alerting', async () => {
    for (const report of [
      { ...APP_REPORT, source: 'other-app/ios' },
      { ...APP_REPORT, service: 'mactools-ecommerce' },
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

  test('POST /api/mactools/ios/error includes CORS headers on rejection', async () => {
    const { status, headers } = await postJson(server, IOS_ERROR_PATH, {});

    expect(status).toBe(400);
    expect(headers['access-control-allow-origin']).toBe('*');
  });

  test('throttles accepted reports after the per-route cap', async () => {
    const { reserveReportSlot } = require('../app/routes/verticals/mactools-ios');
    const now = Date.now();
    while (reserveReportSlot(now)) { /* fill the window */ }

    const { status, headers, body } = await postJson(server, IOS_ERROR_PATH, APP_REPORT);
    expect(status).toBe(429);
    expect(headers['retry-after']).toBe('600');
    expect(body).toMatchObject({ received: false, status: 'throttled' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(reserveReportSlot(now + 11 * 60 * 1000)).toBe(true);
  });

  test('applies the mactools-ios identity to webhook alerts carrying the iOS service', () => {
    const appAlert = applyCustomerIdentity({
      issueTitle: APP_REPORT.errorMessage,
      culprit: `POST ${IOS_ERROR_PATH}`,
      tags: [['service', APP_SERVICE]],
    });
    expect(appAlert).toMatchObject({
      customer: 'ios-demos',
      verticalLabel: 'Mac Tools AMP — Weekly Payment (iOS)',
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
      issueTitle: 'TypeError: renderCart',
      culprit: 'app/services/verticals/4e150e99.js — renderCart',
      tags: [['service', 'mactools-ecommerce']],
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
          id: 'mactools-ios-1',
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
    expect(APP_REPO).toBe('github.com/COG-GTM/event-driven-ios');
    expect(APP_REMEDIATION_DIRECTIVE).toContain(APP_REPO);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('WeeklyPayment.swift');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('PaymentAllocationCodes.ledgerCodes');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('SeedData.swift');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('FLEX36');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('PaymentError.unmappedPlanCode');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('MT-PAY-4221');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('swift test --package-path MacToolsCore');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('MACTOOLS_DISABLE_FAILURE_REPORTS=1');
    expect(APP_REMEDIATION_DIRECTIVE).not.toContain('4e150e99.js —');
  });

  test('directive keeps the work on macOS and never merges the demo fix PR', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('do not create child sessions');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('uname -s');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('only if this session is not on macOS');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('DO NOT MERGE');
  });

  test('MACTOOLS_IOS_SESSION_PLATFORM defaults to macos when unset', () => {
    const original = process.env.MACTOOLS_IOS_SESSION_PLATFORM;
    let value;
    try {
      delete process.env.MACTOOLS_IOS_SESSION_PLATFORM;
      jest.isolateModules(() => {
        ({ MACTOOLS_IOS_SESSION_PLATFORM: value } = require('../app/services/verticals/mactools-ios'));
      });
      expect(value).toBe('macos');
    } finally {
      if (original === undefined) delete process.env.MACTOOLS_IOS_SESSION_PLATFORM;
      else process.env.MACTOOLS_IOS_SESSION_PLATFORM = original;
    }
  });

  test('uses the org default when MACTOOLS_IOS_SESSION_PLATFORM is empty', async () => {
    const original = process.env.MACTOOLS_IOS_SESSION_PLATFORM;
    let isolatedReportAppFailure;
    let isolatedCreateSessionAndAlert;
    try {
      process.env.MACTOOLS_IOS_SESSION_PLATFORM = '';
      jest.isolateModules(() => {
        ({ createSessionAndAlert: isolatedCreateSessionAndAlert } = require('../app/services/devin-session'));
        ({ reportAppFailure: isolatedReportAppFailure } = require('../app/services/verticals/mactools-ios'));
      });

      await isolatedReportAppFailure(APP_REPORT).sessionPromise;
      expect(isolatedCreateSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
        sessionPlatform: undefined,
      }));
    } finally {
      if (original === undefined) delete process.env.MACTOOLS_IOS_SESSION_PLATFORM;
      else process.env.MACTOOLS_IOS_SESSION_PLATFORM = original;
    }
  });
});
