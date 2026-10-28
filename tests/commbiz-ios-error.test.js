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
  APP_PROJECT,
  APP_RELEASE,
  APP_RELEASE_PREFIX,
  APP_REMEDIATION_DIRECTIVE,
  APP_REPO,
  APP_SCENARIO,
  APP_SENTRY_ISSUE_QUERY,
  APP_SERVICE,
  APP_SOURCE_PREFIX,
  COMMBIZ_IOS_SESSION_PLATFORM,
  IOS_ERROR_PATH,
  isAppRelease,
  isAppReport,
  reportAppFailure,
} = require('../app/services/verticals/commbiz-ios');
const router = require('../app/routes/verticals/commbizapp');
const {
  applyCustomerIdentity,
  isInstantPathEvent,
} = require('../app/routes/sentry-webhook');

const ORG_ID = 'org_69IXJFLrljx8zSAw';

const APP_REPORT = {
  source: `${APP_SOURCE_PREFIX}web`,
  service: APP_SERVICE,
  release: APP_RELEASE,
  environment: 'production',
  platform: 'web',
  screen: 'payment_detail',
  action: 'authorise',
  reference: 'CBZ-MH2K1Q',
  paymentId: 'pay-1',
  paymentRef: 'PAY-9A8DC2A114',
  paymentType: 'batch',
  paymentName: 'Wages week 43',
  amount: 48620,
  authorisersRequired: 2,
  tier: 2,
  roleCode: 'AUTH_L2',
  roleCodes: ['ADMIN', 'AUTH_L1', 'AUTH_L2'],
  fromAccount: 'acc-txn',
  toLabel: '14 employees',
  lineCount: 14,
  batchSize: 1,
  device: 'browser',
  osVersion: 'web',
  appVersion: '1.0.0',
  errorType: 'AuthorisationEntitlementError.unmappedRoleCode',
  errorCode: 'CBZ-AUTH-4031',
  errorMessage: 'No central entitlement key for legacy role AUTH_L2 (payment PAY-9A8DC2A114, tier 2)',
  stackTrace: [
    'AuthoriserEntitlements.resolve (package:commbiz_app/core/authoriser_entitlements.dart:118)',
    'AppModel.authorise (package:commbiz_app/app_model.dart:112)',
  ].join('\n'),
  devinUserId: 'user-75c426edb9d1493084f757acf6bc8543',
  devinOrgId: ORG_ID,
  devinEmail: 'shubhra.ganguly@cognition.ai',
};

function request(server, path, method, body, headers = {}) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data ? JSON.parse(data) : null }));
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const postJson = (server, path, body) => request(server, path, 'POST', body);

describe('CommBiz app authorisation failure report', () => {
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
    jest.clearAllMocks();
  });

  test('identity constants match the CommBiz client contract', () => {
    expect(IOS_ERROR_PATH).toBe('/api/commbiz/ios/error');
    expect(APP_SERVICE).toBe('customer-commbiz-ios');
    expect(APP_SOURCE_PREFIX).toBe('commbiz-mobile/');
    expect(APP_RELEASE_PREFIX).toBe('commbiz-app-flutter@');
    expect(APP_REPO).toBe('github.com/COG-GTM/event-driven-ios');
    expect(APP_SCENARIO).toBe('authoriser-entitlement-key');
    expect(APP_CULPRIT).toBe('CommBizApp/lib/core/authoriser_entitlements.dart — AuthoriserEntitlementRegistry.keyFor');
    expect(APP_SENTRY_ISSUE_QUERY).toContain('AuthorisationEntitlementError');
    expect(isAppRelease(`${APP_RELEASE_PREFIX}1.2.0`)).toBe(true);
    expect(isAppRelease('commbank-app-flutter@1.0.0')).toBe(false);
  });

  test('accepts a CommBiz report, captures it in Sentry and requests a Devin session', async () => {
    const { status, headers, body } = await postJson(server, IOS_ERROR_PATH, APP_REPORT);

    expect(status).toBe(202);
    expect(headers['access-control-allow-origin']).toBe('*');
    expect(body).toMatchObject({ received: true, status: 'accepted', service: APP_SERVICE, sessionRequested: true });
    expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);

    expect(incrementMetric).toHaveBeenCalledWith('commbiz.ios.authorise.failure', expect.objectContaining({
      route: IOS_ERROR_PATH,
      errorClass: APP_REPORT.errorType,
      platform: 'web',
      tier: 2,
      roleCode: 'AUTH_L2',
    }));

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [error, context] = Sentry.captureException.mock.calls[0];
    expect(error.name).toBe(APP_REPORT.errorType);
    expect(error.message).toBe(APP_REPORT.errorMessage);
    expect(error.stack).toContain('authoriser_entitlements.dart');
    expect(context.tags).toMatchObject({
      route: IOS_ERROR_PATH,
      service: APP_SERVICE,
      customer: APP_SERVICE,
      scenario: APP_SCENARIO,
      alert_path: 'instant',
      role_code: 'AUTH_L2',
      tier: '2',
      error_code: 'CBZ-AUTH-4031',
    });
    expect(context.extra).toMatchObject({ release: APP_RELEASE, paymentRef: 'PAY-9A8DC2A114', amount: 48620, roleCodes: APP_REPORT.roleCodes });

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData).toMatchObject({
      issueTitle: `${APP_REPORT.errorType}: ${APP_REPORT.errorMessage}`,
      culprit: APP_CULPRIT,
      errorType: APP_REPORT.errorType,
      errorValue: APP_REPORT.errorMessage,
      service: APP_SERVICE,
      customer: 'cba',
      project: APP_PROJECT,
      release: APP_RELEASE,
      sessionPlatform: COMMBIZ_IOS_SESSION_PLATFORM || undefined,
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
      devinUserId: APP_REPORT.devinUserId,
      devinEmail: APP_REPORT.devinEmail,
      devinOrgId: ORG_ID,
      slackMemberId: '',
      verticalLabel: 'CommBiz app — Authorise payments (web)',
    });
    expect(alertData.issueUrl).toContain(encodeURIComponent(APP_SENTRY_ISSUE_QUERY));
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'scenario', value: APP_SCENARIO },
      { key: 'service', value: APP_SERVICE },
    ]));
  });

  test('defaults the fix session to a macOS platform like the CommBank bridge', () => {
    expect(COMMBIZ_IOS_SESSION_PLATFORM).toBe(process.env.COMMBIZ_IOS_SESSION_PLATFORM === undefined ? 'macos' : process.env.COMMBIZ_IOS_SESSION_PLATFORM);
  });

  test('the remediation directive names the repo, the failing path, the registry omission and the fix', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain(APP_REPO);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('AGENTS.md');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('Authorise → Wages week 43 → Authorise');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('never maps\n`AUTH_L2`');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('`AUTH_L2` → `payments.authorise.tier2`');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('completeness test');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('CBZ_DISABLE_FAILURE_REPORTS=1');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('The PR description must explain');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('only dual-authorisation payments were affected');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('`CommBankApp/`');
    expect(APP_REMEDIATION_DIRECTIVE).not.toMatch(/planted|mock|fake/i);
  });

  test('resolves the on-call mention from the report rather than a hard-coded person', () => {
    const { sessionPromise } = reportAppFailure({ ...APP_REPORT, devinEmail: 'someone.else@cognition.ai' });
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinEmail).toBe('someone.else@cognition.ai');
    expect(alertData.slackMemberId).toBe('');
    expect(alertData.slackMemberIdFallback).toBe(process.env.COMMBIZ_SLACK_MEMBER_ID || '');
    return sessionPromise;
  });

  test('answers CORS preflight for the hosted web build', async () => {
    const { status, headers } = await request(server, IOS_ERROR_PATH, 'OPTIONS');
    expect(status).toBe(204);
    expect(headers['access-control-allow-origin']).toBe('*');
    expect(headers['access-control-allow-methods']).toContain('POST');
  });

  test('rejects reports from other clients', async () => {
    expect(isAppReport({ ...APP_REPORT, service: 'customer-cba-ios' })).toBe(false);
    expect(isAppReport({ ...APP_REPORT, source: 'commbank-mobile/web' })).toBe(false);
    expect(isAppReport(APP_REPORT)).toBe(true);

    const foreign = await postJson(server, IOS_ERROR_PATH, { ...APP_REPORT, service: 'customer-cba-ios' });
    expect(foreign.status).toBe(400);
    expect(foreign.body).toMatchObject({ received: false, status: 'rejected' });

    const empty = await postJson(server, IOS_ERROR_PATH, {});
    expect(empty.status).toBe(400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('throttles once the report cap is reached and tells the client when to retry', () => {
    const { reserveReportSlot, retryAfterSeconds } = router;
    const now = Date.now();
    let accepted = 0;
    for (let i = 0; i < 20; i += 1) {
      if (reserveReportSlot(now + i)) accepted += 1;
    }
    expect(accepted).toBeLessThanOrEqual(10);
    expect(reserveReportSlot(now + 100)).toBe(false);
    expect(retryAfterSeconds(now + 100)).toBeGreaterThan(0);
    expect(retryAfterSeconds(now + 100)).toBeLessThanOrEqual(10 * 60);
  });

  test('routes webhook events through the commbiz-ios identity and keeps it apart from the CommBank app', () => {
    const appAlert = applyCustomerIdentity({
      issueTitle: APP_REPORT.errorMessage,
      culprit: `POST ${IOS_ERROR_PATH}`,
      release: APP_RELEASE,
      tags: [['service', APP_SERVICE]],
    });
    expect(appAlert).toMatchObject({
      customer: 'cba',
      verticalLabel: 'CommBiz app (Flutter web/iOS)',
      service: APP_SERVICE,
      project: APP_PROJECT,
      release: APP_RELEASE,
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(appAlert.tags).toEqual(expect.arrayContaining([
      { key: 'customer', value: APP_SERVICE },
      { key: 'scenario', value: APP_SCENARIO },
    ]));

    const cbaAlert = applyCustomerIdentity({
      issueTitle: 'PaymentAddressingError.unregisteredPayIdType',
      culprit: 'POST /api/cba/ios/error',
      tags: [['service', 'customer-cba-ios']],
    });
    expect(cbaAlert.service).toBe('customer-cba-ios');
    expect(cbaAlert.promptAppendix).not.toBe(APP_REMEDIATION_DIRECTIVE);
  });

  test('marks CommBiz events as instant-path so the webhook does not alert twice', () => {
    expect(isInstantPathEvent({ culprit: APP_CULPRIT, tags: [] })).toBe(true);
    expect(isInstantPathEvent({ culprit: `POST ${IOS_ERROR_PATH}`, tags: [] })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'resolve (CommBizApp/lib/core/authoriser_entitlements.dart)', tags: [] })).toBe(true);
    expect(isInstantPathEvent({ culprit: 'settlePayment (app/services/verticals/cba.js)', tags: [] })).toBe(false);
  });
});
