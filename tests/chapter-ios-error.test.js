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
  CHAPTER_IOS_SESSION_PLATFORM,
  isAppReport,
  reportAppFailure,
  resolveUserIdByEmail,
} = require('../app/services/verticals/chapter-ios');
const router = require('../app/routes/verticals/chapter-ios');
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
  screen: 'otc_checkout',
  action: 'place_otc_order',
  memberId: 'CH-2041887',
  planId: 'H1036-236',
  planName: 'Humana Gold Plus H1036-236 (HMO)',
  planYear: '2026',
  carrierId: 'humana',
  crosswalkFrom: 'H1036-200',
  zip: '33603',
  cartTotal: '35.74',
  benefitRemaining: '50',
  items: 'tylenol-es-100:1,zyrtec-24h-30:1',
  device: 'iPhone 18 Pro (Simulator)',
  osVersion: 'iOS 27.0',
  appVersion: '2.4.0',
  errorType: 'OTCError.fulfillmentProgramNotFound',
  errorCode: 'CH-OTC-4041',
  errorMessage: 'No OTC fulfillment program for plan H1036-236 (humana).',
  stackTrace: [
    'OTCCheckoutService.placeOrder(cart:benefit:member:now:sequence:) (ChapterCore/Sources/ChapterCore/OTCCheckout.swift:96)',
    'ChapterAppModel.placeOrder() (ChapterMobile/ChapterMobileApp.swift:142)',
  ].join('\n'),
  devinUserId: '',
  devinEmail: 'hannah.kyme@cognition.ai',
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

describe('Chapter OTC iOS checkout failure report', () => {
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
      verticalLabel: 'Chapter OTC — Benefit Checkout (iOS)',
      project: APP_PROJECT,
      release: APP_RELEASE,
      issueTitle: `${APP_REPORT.errorType}: ${APP_REPORT.errorMessage}`,
      culprit: 'chapter-otc/ios otc_checkout place_otc_order',
      devinOrgId: ORG_ID,
      devinEmail: APP_REPORT.devinEmail,
      slackMemberId: '',
      sessionPlatform: CHAPTER_IOS_SESSION_PLATFORM || undefined,
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.slackChannelId).toBeUndefined();
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: IOS_ERROR_PATH },
      { key: 'service', value: APP_SERVICE },
      { key: 'customer', value: APP_SERVICE },
      { key: 'plan_id', value: 'H1036-236' },
      { key: 'carrier_id', value: 'humana' },
      { key: 'error_code', value: 'CH-OTC-4041' },
      { key: 'scenario', value: APP_SCENARIO },
      { key: 'alert_path', value: 'instant' },
    ]));
    expect(alertData.extra).toMatchObject({
      memberId: 'CH-2041887',
      planId: 'H1036-236',
      planName: APP_REPORT.planName,
      planYear: '2026',
      carrierId: 'humana',
      crosswalkFrom: 'H1036-200',
      cartTotal: '35.74',
      items: APP_REPORT.items,
      errorCode: 'CH-OTC-4041',
      reporterEmail: APP_REPORT.devinEmail,
    });
    expect(incrementMetric).toHaveBeenCalledWith('otc.ios.failure', expect.objectContaining({
      route: IOS_ERROR_PATH,
      errorClass: APP_REPORT.errorType,
      planId: 'H1036-236',
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
      plan_id: 'H1036-236',
      scenario: APP_SCENARIO,
      alert_path: 'instant',
    });
    const processor = scope.addEventProcessor.mock.calls[0][0];
    expect(processor({ release: 'host@1.0.0', environment: 'staging', message: 'x' })).toEqual({
      release: APP_RELEASE,
      environment: 'prod',
      message: 'x',
    });
    expect(context.extra).toMatchObject({
      memberId: 'CH-2041887',
      planId: 'H1036-236',
    });
  });

  test('clips oversized strings before they reach Sentry and the alert', async () => {
    await reportAppFailure({
      ...APP_REPORT,
      errorMessage: 'x'.repeat(600),
      stackTrace: 'y'.repeat(5000),
      items: 'z'.repeat(600),
    }).sessionPromise;

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.sessionPlatform).toBe(CHAPTER_IOS_SESSION_PLATFORM || undefined);
    expect(alertData.errorValue).toHaveLength(512);
    expect(alertData.extra.stackTrace).toHaveLength(4000);
    expect(alertData.extra.items).toHaveLength(512);
  });

  test('falls back to the configured Slack member when no email is forwarded', async () => {
    const report = { ...APP_REPORT };
    delete report.devinEmail;

    await reportAppFailure(report).sessionPromise;

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.sessionPlatform).toBe(CHAPTER_IOS_SESSION_PLATFORM || undefined);
    expect(alertData.devinUserId).toBe(report.devinUserId);
    expect(alertData.devinOrgId).toBe(report.devinOrgId);
    expect(alertData.devinEmail).toBeUndefined();
    expect(alertData.slackMemberId).toBe(process.env.VERIZON_SLACK_MEMBER_ID || '');
    expect(alertData.slackMemberIdFallback).toBe(process.env.VERIZON_SLACK_MEMBER_ID || '');
  });

  test('creates the session as the reporter resolved from devinEmail', async () => {
    listOrgUsers.mockResolvedValue([
      { user_id: 'user-other', email: 'someone@cognition.ai' },
      { user_id: 'user-hannah', email: 'Hannah.Kyme@cognition.ai' },
    ]);

    await reportAppFailure(APP_REPORT).sessionPromise;

    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, expect.any(Object));
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('user-hannah');
    expect(createSessionAndAlert.mock.calls[0][0].sessionPlatform).toBe(CHAPTER_IOS_SESSION_PLATFORM || undefined);
  });

  test('falls back to enterprise admins, then to the customer default user', async () => {
    listEnterpriseAdmins.mockResolvedValueOnce([{ user_id: 'user-admin', email: APP_REPORT.devinEmail }]);
    await reportAppFailure(APP_REPORT).sessionPromise;
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('user-admin');
    expect(createSessionAndAlert.mock.calls[0][0].sessionPlatform).toBe(CHAPTER_IOS_SESSION_PLATFORM || undefined);

    await reportAppFailure(APP_REPORT).sessionPromise;
    expect(createSessionAndAlert.mock.calls[1][0].devinUserId).toBeUndefined();
    expect(createSessionAndAlert.mock.calls[1][0].sessionPlatform).toBe(CHAPTER_IOS_SESSION_PLATFORM || undefined);
  });

  test('uses a forwarded devinUserId without looking up the email', async () => {
    await reportAppFailure({ ...APP_REPORT, devinUserId: 'user-explicit' }).sessionPromise;

    expect(listOrgUsers).not.toHaveBeenCalled();
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('user-explicit');
    expect(createSessionAndAlert.mock.calls[0][0].sessionPlatform).toBe(CHAPTER_IOS_SESSION_PLATFORM || undefined);
  });

  test('resolveUserIdByEmail returns empty on missing input or lookup failure', async () => {
    expect(await resolveUserIdByEmail('', ORG_ID)).toBe('');
    expect(await resolveUserIdByEmail(APP_REPORT.devinEmail, '')).toBe('');
    listOrgUsers.mockRejectedValueOnce(new Error('boom'));
    expect(await resolveUserIdByEmail(APP_REPORT.devinEmail, ORG_ID)).toBe('');
  });

  test('isAppReport requires both the Chapter source prefix and service', () => {
    expect(isAppReport(APP_REPORT)).toBe(true);
    expect(isAppReport({ ...APP_REPORT, source: 'chapter-otc/android' })).toBe(true);
    expect(isAppReport({ ...APP_REPORT, source: 'westpac-mobile/ios' })).toBe(false);
    expect(isAppReport({ ...APP_REPORT, service: 'customer-chapter-web' })).toBe(false);
    expect(isAppReport({})).toBe(false);
    expect(isAppReport(null)).toBe(false);
  });

  test('rejects foreign, missing, and wrong-service reports without alerting', async () => {
    for (const report of [
      { ...APP_REPORT, source: 'other-app/ios' },
      { ...APP_REPORT, service: 'customer-chapter-web' },
      {},
    ]) {
      const { status, body } = await postJson(server, IOS_ERROR_PATH, report);
      expect(status).toBe(400);
      expect(body).toMatchObject({ received: false, status: 'rejected' });
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('sends no CORS headers, so browsers on other origins cannot post reports', async () => {
    const { port } = server.address();
    const preflight = await fetch(`http://127.0.0.1:${port}${IOS_ERROR_PATH}`, {
      method: 'OPTIONS',
      headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' },
    });
    expect(preflight.headers.get('access-control-allow-origin')).toBeNull();

    const { status, headers } = await postJson(server, IOS_ERROR_PATH, {});
    expect(status).toBe(400);
    expect(headers['access-control-allow-origin']).toBeUndefined();
  });

  test('throttles accepted reports after the per-route cap', async () => {
    const { reserveReportSlot } = require('../app/routes/verticals/chapter-ios');
    const now = Date.now();
    while (reserveReportSlot(now)) { /* fill the window */ }

    const { status, headers, body } = await postJson(server, IOS_ERROR_PATH, APP_REPORT);
    expect(status).toBe(429);
    expect(Number(headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(headers['retry-after'])).toBeLessThanOrEqual(600);
    expect(body).toMatchObject({ received: false, status: 'throttled' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(reserveReportSlot(now + 11 * 60 * 1000)).toBe(true);
  });

  test('Retry-After counts down to when the oldest slot frees', () => {
    const { reserveReportSlot, retryAfterSeconds } = require('../app/routes/verticals/chapter-ios');
    const start = Date.now() + 60 * 60 * 1000;
    while (reserveReportSlot(start)) { /* fill a fresh window */ }
    expect(retryAfterSeconds(start)).toBe(600);
    expect(retryAfterSeconds(start + 599 * 1000)).toBe(1);
    expect(retryAfterSeconds(start + 599.5 * 1000)).toBe(1);
  });

  test('applies the chapter-ios identity to webhook alerts carrying the iOS service', () => {
    const appAlert = applyCustomerIdentity({
      issueTitle: APP_REPORT.errorMessage,
      culprit: `POST ${IOS_ERROR_PATH}`,
      tags: [['service', APP_SERVICE]],
    });
    expect(appAlert).toMatchObject({
      customer: 'ios-demos',
      verticalLabel: 'Chapter OTC — Benefit Checkout (iOS)',
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
      tags: [['service', 'customer-chapter-web']],
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
          id: 'chapter-ios-1',
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
    expect(APP_REMEDIATION_DIRECTIVE).toContain('OTCCheckout.swift');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('OTCFulfillmentPrograms.programs');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('SeedData.swift');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('H1036-236');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('OTCError.fulfillmentProgramNotFound');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('CH-OTC-4041');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('swift test --package-path ChapterCore');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('CHAPTER_DISABLE_FAILURE_REPORTS=1');
    expect(APP_REMEDIATION_DIRECTIVE).not.toContain('4e150e99.js —');
  });

  test('directive keeps the work on macOS and never merges the demo fix PR', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('do not create child sessions');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('uname -s');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('only if this session is not on macOS');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('DO NOT MERGE');
  });

  test('CHAPTER_IOS_SESSION_PLATFORM defaults to macos when unset', () => {
    const original = process.env.CHAPTER_IOS_SESSION_PLATFORM;
    let value;
    try {
      delete process.env.CHAPTER_IOS_SESSION_PLATFORM;
      jest.isolateModules(() => {
        ({ CHAPTER_IOS_SESSION_PLATFORM: value } = require('../app/services/verticals/chapter-ios'));
      });
      expect(value).toBe('macos');
    } finally {
      if (original === undefined) delete process.env.CHAPTER_IOS_SESSION_PLATFORM;
      else process.env.CHAPTER_IOS_SESSION_PLATFORM = original;
    }
  });

  test('uses the org default when CHAPTER_IOS_SESSION_PLATFORM is empty', async () => {
    const original = process.env.CHAPTER_IOS_SESSION_PLATFORM;
    let isolatedReportAppFailure;
    let isolatedCreateSessionAndAlert;
    try {
      process.env.CHAPTER_IOS_SESSION_PLATFORM = '';
      jest.isolateModules(() => {
        ({ createSessionAndAlert: isolatedCreateSessionAndAlert } = require('../app/services/devin-session'));
        ({ reportAppFailure: isolatedReportAppFailure } = require('../app/services/verticals/chapter-ios'));
      });

      await isolatedReportAppFailure(APP_REPORT).sessionPromise;
      expect(isolatedCreateSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
        sessionPlatform: undefined,
      }));
    } finally {
      if (original === undefined) delete process.env.CHAPTER_IOS_SESSION_PLATFORM;
      else process.env.CHAPTER_IOS_SESSION_PLATFORM = original;
    }
  });
});
