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

const originalEnvironment = {
  IOS_DEMOS_SESSION_PLATFORM: process.env.IOS_DEMOS_SESSION_PLATFORM,
  IOS_DEMOS_SLACK_MEMBER_ID: process.env.IOS_DEMOS_SLACK_MEMBER_ID,
  REPORT_CAP_IOS_DEMOS_MAX: process.env.REPORT_CAP_IOS_DEMOS_MAX,
  REPORT_CAP_IOS_DEMOS_PER_SLUG_MAX: process.env.REPORT_CAP_IOS_DEMOS_PER_SLUG_MAX,
  REPORT_CAP_IOS_DEMOS_WINDOW_MINUTES: process.env.REPORT_CAP_IOS_DEMOS_WINDOW_MINUTES,
};
process.env.IOS_DEMOS_SESSION_PLATFORM = 'macos';
process.env.IOS_DEMOS_SLACK_MEMBER_ID = 'U-IOS-DEMO-ONCALL';
process.env.REPORT_CAP_IOS_DEMOS_MAX = '10';
process.env.REPORT_CAP_IOS_DEMOS_PER_SLUG_MAX = '3';
process.env.REPORT_CAP_IOS_DEMOS_WINDOW_MINUTES = '10';

const express = require('express');
const { runWithLegacyAlertsSuppressed } = require('../app/services/oncall-suppression');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { listOrgUsers, listEnterpriseAdmins } = require('../app/services/devin-api');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric } = require('../app/telemetry/datadog');
const {
  APP_PROJECT,
  APP_REPO,
  APP_SERVICE,
  IOS_DEMOS_SESSION_PLATFORM,
  IOS_ERROR_PATH,
  SLUG_PATTERN,
  WEBHOOK_REMEDIATION_DIRECTIVE,
  buildRemediationDirective,
  isAppReport,
  reportAppFailure,
  resolveUserIdByEmail,
  sourceFor,
} = require('../app/services/verticals/ios-demos');
const router = require('../app/routes/verticals/ios-demos');
const {
  applyCustomerIdentity,
  isInstantPathEvent,
} = require('../app/routes/sentry-webhook');

for (const [name, value] of Object.entries(originalEnvironment)) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const ORG_ID = 'org_ios_demos';

function appReport(slug = 'abcd1234') {
  return {
    source: sourceFor(slug),
    service: APP_SERVICE,
    release: `ios-demo-${slug}@1.0.0`,
    environment: 'test',
    platform: 'ios',
    screen: 'checkout',
    action: 'place_order',
    device: 'iPhone 18 Pro',
    osVersion: 'iOS 27.0',
    appVersion: '1.2.3',
    appName: 'Demo Shop',
    errorType: 'CheckoutError',
    errorMessage: 'The checkout failed',
    stackTrace: 'CheckoutView.submit (Sources/CheckoutView.swift:42)',
    sentryEventId: 'event-ios-demo',
    devinUserId: 'user-forwarded',
    devinOrgId: ORG_ID,
  };
}

async function postJson(server, path, body, headers = {}) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.json(),
  };
}

describe('shared iOS demo failure report endpoint', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      if (req.headers['x-oncall-mode'] === '1') {
        return runWithLegacyAlertsSuppressed(() => next());
      }
      return next();
    });
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

  test('defines the shared customer identity and slug-specific source', () => {
    expect(APP_PROJECT).toBe('ios-event-demos');
    expect(APP_REPO).toBe('github.com/COG-GTM/event-driven-demos-ios');
    expect(APP_SERVICE).toBe('customer-ios-demo');
    expect(IOS_ERROR_PATH).toBe('/api/ios/:slug/error');
    expect(SLUG_PATTERN.test('abcd1234')).toBe(true);
    expect(SLUG_PATTERN.test('ABCDEF12')).toBe(false);
    expect(sourceFor('abcd1234')).toBe('ios-demos/abcd1234/ios');
    expect(isAppReport('abcd1234', appReport())).toBe(true);
    expect(isAppReport('abcd1234', appReport('87654321'))).toBe(false);
  });

  test('rejects invalid slugs before alerting', async () => {
    for (const slug of ['ABCDEF12', 'abc', 'abcdefg12', '../etc']) {
      const { status, body } = await postJson(
        server,
        `/api/ios/${encodeURIComponent(slug)}/error`,
        appReport(),
      );
      expect(status).toBe(400);
      expect(body).toEqual({
        received: false,
        status: 'rejected',
        error: 'Unknown demo slug',
      });
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects a source or service mismatch without alerting', async () => {
    for (const report of [
      { ...appReport(), source: 'ios-demos/87654321/ios' },
      { ...appReport(), source: 'other-demo/abcd1234/ios' },
      { ...appReport(), service: 'customer-other-ios-demo' },
    ]) {
      const { status, body } = await postJson(server, '/api/ios/abcd1234/error', report);
      expect(status).toBe(400);
      expect(body.error).toContain('ios-demos/abcd1234/ios');
      expect(body.error).toContain(APP_SERVICE);
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('accepts valid reports with a macOS session and slug-specific alert metadata', async () => {
    const report = appReport();
    const { status, body } = await postJson(server, '/api/ios/abcd1234/error', report);

    expect(status).toBe(202);
    expect(body).toMatchObject({
      received: true,
      status: 'accepted',
      service: APP_SERVICE,
      sessionRequested: true,
      slug: 'abcd1234',
    });
    expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({
      customer: 'ios-demos',
      service: APP_SERVICE,
      project: APP_PROJECT,
      release: 'ios-demo-abcd1234@1.0.0',
      sessionPlatform: 'macos',
      promptAppendix: buildRemediationDirective('abcd1234'),
      verticalLabel: 'Demo Shop (iOS demo abcd1234)',
      culprit: 'ios-demos/abcd1234/ios checkout place_order',
    });
    expect(createSessionAndAlert.mock.calls[0][0].tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/ios/abcd1234/error' },
      { key: 'service', value: APP_SERVICE },
      { key: 'customer', value: APP_SERVICE },
      { key: 'demo_slug', value: 'abcd1234' },
      { key: 'scenario', value: 'ios-demo-abcd1234' },
      { key: 'platform', value: 'ios' },
      { key: 'screen', value: 'checkout' },
      { key: 'action', value: 'place_order' },
      { key: 'alert_path', value: 'instant' },
    ]));
    expect(new URL(createSessionAndAlert.mock.calls[0][0].issueUrl).searchParams.get('project'))
      .toBe(process.env.SENTRY_PROJECT_ID || '');
    expect(Sentry.captureException.mock.calls[0][0].stack).toBe(
      'CheckoutError: The checkout failed\n'
      + '    at checkout.place_order (ios-demos/abcd1234/ios/checkout/place_order.swift:1:1)',
    );
    expect(Sentry.captureException.mock.calls[0][0].stack).not.toContain(report.stackTrace);
    expect(decodeURIComponent(createSessionAndAlert.mock.calls[0][0].issueUrl)).toContain(
      'is:unresolved demo_slug:abcd1234',
    );
    expect(incrementMetric).toHaveBeenCalledWith('ios_demo.failure', expect.objectContaining({
      route: '/api/ios/abcd1234/error',
      platform: 'ios',
      screen: 'checkout',
      action: 'place_order',
    }));
  });

  test('accepts on-call reports without requesting a legacy session', async () => {
    const { status, body } = await postJson(
      server,
      '/api/ios/abcd1234/error',
      appReport(),
      { 'x-oncall-mode': '1' },
    );

    expect(status).toBe(202);
    expect(body.sessionRequested).toBe(false);
  });

  test('clips context to 12 scalar entries and never adds it to tags', async () => {
    const context = {
      ['k'.repeat(45)]: 'v'.repeat(300),
      count: 42,
      rejectedBoolean: true,
      rejectedNull: null,
      ...Object.fromEntries(Array.from({ length: 12 }, (_value, index) => [`key${index}`, `value${index}`])),
    };
    await reportAppFailure('abcd1234', { ...appReport(), context }).sessionPromise;

    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.extra.context).toEqual(expect.objectContaining({
      ['k'.repeat(40)]: 'v'.repeat(256),
      count: 42,
      key0: 'value0',
      key9: 'value9',
    }));
    expect(Object.keys(alertData.extra.context)).toHaveLength(12);
    expect(alertData.extra.context.rejectedBoolean).toBeUndefined();
    expect(alertData.extra.context.rejectedNull).toBeUndefined();
    expect(alertData.tags).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 'context' }),
    ]));
    expect(Sentry.captureException.mock.calls[0][1].extra.context).toEqual(alertData.extra.context);
  });

  test('resolves the reporter by email and falls back to the configured Slack member', async () => {
    listOrgUsers.mockResolvedValueOnce([
      { user_id: 'user-other', email: 'other@example.com' },
      { user_id: 'user-reporter', email: 'Reporter@example.com' },
    ]);
    await reportAppFailure('abcd1234', {
      ...appReport(),
      devinUserId: '',
      devinEmail: 'reporter@example.com',
    }).sessionPromise;

    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, expect.any(Object));
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('user-reporter');

    createSessionAndAlert.mockClear();
    const report = { ...appReport() };
    delete report.devinEmail;
    await reportAppFailure('abcd1234', report).sessionPromise;
    expect(createSessionAndAlert.mock.calls[0][0].slackMemberId).toBe('U-IOS-DEMO-ONCALL');
    expect(createSessionAndAlert.mock.calls[0][0].slackMemberIdFallback).toBe('U-IOS-DEMO-ONCALL');
    expect(await resolveUserIdByEmail('', ORG_ID)).toBe('');
    expect(await resolveUserIdByEmail('reporter@example.com', '')).toBe('');
  });

  test('defaults the session platform to macOS when the environment override is unset', async () => {
    const original = process.env.IOS_DEMOS_SESSION_PLATFORM;
    let isolatedService;
    let isolatedCreateSessionAndAlert;
    try {
      delete process.env.IOS_DEMOS_SESSION_PLATFORM;
      jest.isolateModules(() => {
        ({ createSessionAndAlert: isolatedCreateSessionAndAlert } = require('../app/services/devin-session'));
        isolatedService = require('../app/services/verticals/ios-demos');
      });
      expect(isolatedService.IOS_DEMOS_SESSION_PLATFORM).toBe('macos');
      await isolatedService.reportAppFailure('abcd1234', appReport()).sessionPromise;
      expect(isolatedCreateSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
        sessionPlatform: 'macos',
      }));
    } finally {
      if (original === undefined) delete process.env.IOS_DEMOS_SESSION_PLATFORM;
      else process.env.IOS_DEMOS_SESSION_PLATFORM = original;
    }
  });

  test('uses the org default when IOS_DEMOS_SESSION_PLATFORM is empty', async () => {
    const original = process.env.IOS_DEMOS_SESSION_PLATFORM;
    let isolatedService;
    let isolatedCreateSessionAndAlert;
    try {
      process.env.IOS_DEMOS_SESSION_PLATFORM = '';
      jest.isolateModules(() => {
        ({ createSessionAndAlert: isolatedCreateSessionAndAlert } = require('../app/services/devin-session'));
        isolatedService = require('../app/services/verticals/ios-demos');
      });
      await isolatedService.reportAppFailure('abcd1234', appReport()).sessionPromise;
      expect(isolatedCreateSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
        sessionPlatform: undefined,
      }));
    } finally {
      if (original === undefined) delete process.env.IOS_DEMOS_SESSION_PLATFORM;
      else process.env.IOS_DEMOS_SESSION_PLATFORM = original;
    }
  });

  test('answers the CORS preflight on the slug route', async () => {
    const { port } = server.address();
    const response = await fetch(`http://127.0.0.1:${port}/api/ios/abcd1234/error`, {
      method: 'OPTIONS',
      headers: { origin: 'http://localhost:8080', 'access-control-request-method': 'POST' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(response.headers.get('access-control-allow-methods')).toContain('POST');
  });

  test('enforces per-slug caps and does not charge rejected reports', async () => {
    const path = '/api/ios/aaaaaaaa/error';
    const invalid = await postJson(server, path, { ...appReport('aaaaaaaa'), source: 'wrong-source' });
    expect(invalid.status).toBe(400);

    for (let i = 0; i < 3; i += 1) {
      expect((await postJson(server, path, appReport('aaaaaaaa'))).status).toBe(202);
    }
    const throttled = await postJson(server, path, appReport('aaaaaaaa'));
    expect(throttled.status).toBe(429);
    expect(throttled.headers['retry-after']).toBe('600');
    expect(throttled.body.status).toBe('throttled');
    expect((await postJson(server, '/api/ios/bbbbbbbb/error', appReport('bbbbbbbb'))).status).toBe(202);
  });

  test('applies the global cap across slugs', async () => {
    const slugs = ['11111111', '22222222', '33333333', '44444444'];
    const acceptedSlugs = new Set();
    let throttled;
    for (let i = 0; i < 12; i += 1) {
      const slug = slugs[Math.floor(i / 3)];
      const result = await postJson(server, `/api/ios/${slug}/error`, appReport(slug));
      if (result.status === 429) {
        throttled = result;
        break;
      }
      expect(result.status).toBe(202);
      acceptedSlugs.add(slug);
    }
    expect(acceptedSlugs.size).toBeGreaterThan(1);
    expect(throttled.status).toBe(429);
    expect(throttled.headers['retry-after']).toBe('600');
  });

  test('recognizes the shared instant culprit and maps its Sentry identity', () => {
    for (const culprit of [
      'ios-demos/abcd1234/ios checkout place_order',
      'ios-demos/abcd1234/ios/checkout/place_order.swift',
      'checkout.place_order(ios-demos/abcd1234/ios/checkout/place_order)',
    ]) {
      expect(isInstantPathEvent({ culprit, tags: [] })).toBe(true);
    }

    const alertData = applyCustomerIdentity({
      service: APP_SERVICE,
      project: APP_PROJECT,
      release: 'ios-demo-abcd1234@2.0.0',
      culprit: 'ios-demos/abcd1234/ios checkout place_order',
      tags: [
        ['service', APP_SERVICE],
        ['demo_slug', 'abcd1234'],
        ['scenario', 'ios-demo-abcd1234'],
      ],
    });
    expect(alertData).toMatchObject({
      customer: 'ios-demos',
      verticalLabel: 'iOS event-driven demos',
      service: APP_SERVICE,
      project: APP_PROJECT,
      release: 'ios-demo-abcd1234@2.0.0',
      promptAppendix: WEBHOOK_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'customer', value: APP_SERVICE },
      { key: 'service', value: APP_SERVICE },
      ['demo_slug', 'abcd1234'],
      ['scenario', 'ios-demo-abcd1234'],
    ]));
  });

  test('uses both verbatim remediation directives with only the requested slug', () => {
    const directive = buildRemediationDirective('abcd1234');
    expect(directive).toContain('apps/abcd1234/');
    expect(directive).toContain('DEMO.md');
    expect(directive).toContain('uname -s');
    expect(directive).toContain('do not create child sessions');
    expect(directive).toContain('DO NOT MERGE');
    expect(directive).toContain('make demo');
    expect(directive).not.toContain('87654321');
    expect(WEBHOOK_REMEDIATION_DIRECTIVE).toContain('demo_slug');
  });

  test('exports a reservation function with independent global and per-slug caps', () => {
    const names = [
      'REPORT_CAP_IOS_DEMOS_MAX',
      'REPORT_CAP_IOS_DEMOS_PER_SLUG_MAX',
      'REPORT_CAP_IOS_DEMOS_WINDOW_MINUTES',
    ];
    const original = Object.fromEntries(names.map((name) => [name, process.env[name]]));
    let reserveReportSlot;
    try {
      process.env.REPORT_CAP_IOS_DEMOS_MAX = '2';
      process.env.REPORT_CAP_IOS_DEMOS_PER_SLUG_MAX = '1';
      process.env.REPORT_CAP_IOS_DEMOS_WINDOW_MINUTES = '10';
      jest.isolateModules(() => {
        ({ reserveReportSlot } = require('../app/routes/verticals/ios-demos'));
      });
    } finally {
      for (const name of names) {
        if (original[name] === undefined) delete process.env[name];
        else process.env[name] = original[name];
      }
    }

    expect(reserveReportSlot('55555555', 1000)).toBe(true);
    expect(reserveReportSlot('55555555', 1001)).toBe(false);
    expect(reserveReportSlot('66666666', 1001)).toBe(true);
    expect(reserveReportSlot('77777777', 1002)).toBe(false);
    expect(reserveReportSlot('77777777', 601001)).toBe(true);
  });
});
