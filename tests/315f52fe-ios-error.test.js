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
  reportAppFailure,
  isAppReport,
  OWNER,
  APP_REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/315f52fe');
const router = require('../app/routes/verticals/315f52fe');
const { getCustomerConfig } = require('../config/customers');
const { applyCustomerIdentity, extractAlertData, isInstantPathEvent } = require('../app/routes/sentry-webhook');
const verticals = require('../app/routes/verticals');

const ORG_ID = 'org-a26acd61afbe4ff3b0c531026e2cbce5';

// Mirrors FailureReport in Core/Sources/GeForceNowCore/FailureReport.swift.
const APP_REPORT = {
  source: 'geforce-now-ios/ios',
  service: 'customer-315f52fe-ios',
  release: 'geforce-now-ios@1.0.0',
  environment: 'prod',
  platform: 'ios',
  errorType: 'StreamProfileError.unregisteredRig',
  errorMessage: 'No stream profile registered for rig class rtx5080 (GeForce RTX 5080 SuperPOD) on iPhone',
  stackTrace: [
    'StreamProfileRegistry.profile(for:device:) (Core/Sources/GeForceNowCore/StreamProfiles.swift:95)',
    'SessionRequestBuilder.build(game:member:device:network:) (Core/Sources/GeForceNowCore/SessionLaunch.swift:59)',
    'LaunchSessionFlow.run(game:member:device:network:) (Core/Sources/GeForceNowCore/SessionLaunch.swift:129)',
    'PlayViewModel.play(game:) (App/GeForceNOW/Features/Play/PlayViewModel.swift)',
  ].join('\n'),
  screen: 'game_detail',
  action: 'play',
  game: 'cyberpunk-2077',
  tier: 'ultimate',
  rigClass: 'rtx5080',
  device: 'iPhone',
  osVersion: 'iOS 18.2',
  appVersion: '1.0.0',
  sentryEventId: null,
  devinUserId: 'user-abc',
  devinOrgId: ORG_ID,
  devinEmail: 'player@nvidia.example',
  launch: {
    game: 'cyberpunk-2077',
    tier: 'ultimate',
    rigClass: 'rtx5080',
    device: 'iPhone',
    region: 'US West (San Jose)',
    downlinkMbps: 412,
    latencyMs: 9,
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

describe('NVIDIA GeForce NOW iOS failure report (315f52fe)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    incrementMetric.mockClear();
  });

  test('customer config targets Custom-Devin-Demos via the API trigger with friendly aliases', () => {
    const config = getCustomerConfig('315f52fe');
    expect(config.label).toBe('NVIDIA');
    expect(config.githubOrg).toBe('Custom-Devin-Demos');
    expect(config.triggerMode).toBe('api');
    expect(verticals.aliases).toMatchObject({ nvidia: '315f52fe', 'geforce-now': '315f52fe' });
    expect(verticals.routeIds).toContain('315f52fe');
    expect(verticals.pageIds).toContain('315f52fe');
  });

  test('isAppReport accepts only the GeForce NOW iOS identity', () => {
    expect(isAppReport(APP_REPORT)).toBe(true);
    expect(isAppReport({ ...APP_REPORT, source: 'nordstrom-shop/ios' })).toBe(false);
    expect(isAppReport({ ...APP_REPORT, service: 'customer-5b7227b4-mobile' })).toBe(false);
    expect(isAppReport({})).toBe(false);
    expect(isAppReport(null)).toBe(false);
  });

  test('reportAppFailure raises the alert under the app identity, owned by Shawn', () => {
    const { reference } = reportAppFailure(APP_REPORT);

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];

    expect(alertData).toMatchObject({
      customer: '315f52fe',
      service: 'customer-315f52fe-ios',
      verticalLabel: 'NVIDIA',
      project: 'geforce-now-ios',
      release: 'geforce-now-ios@1.0.0',
      platform: 'ios',
      errorType: 'StreamProfileError.unregisteredRig',
      errorValue: APP_REPORT.errorMessage,
      culprit: 'Core/Sources/GeForceNowCore/StreamProfiles.swift \u2014 StreamProfileRegistry.profile(for:device:)',
      devinUserId: OWNER.devinUserId,
      devinOrgId: ORG_ID,
      devinEmail: 'shawn@cognition.ai',
      slackMemberId: 'U08RSEMUV3L',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/315f52fe/ios/error' },
      { key: 'service', value: 'customer-315f52fe-ios' },
      { key: 'platform', value: 'ios' },
      { key: 'screen', value: 'game_detail' },
      { key: 'action', value: 'play' },
      { key: 'game', value: 'cyberpunk-2077' },
      { key: 'tier', value: 'ultimate' },
      { key: 'rig_class', value: 'rtx5080' },
      { key: 'device', value: 'iPhone' },
      { key: 'scenario', value: 'play-ultimate-rig-profile' },
    ]));
    expect(alertData.extra.reference).toBe(reference);
    expect(alertData.extra.stackTrace).toContain('StreamProfiles.swift:95');
    expect(alertData.extra.osVersion).toBe('iOS 18.2');
    expect(alertData.extra.launch).toEqual({
      game: 'cyberpunk-2077',
      tier: 'ultimate',
      rigClass: 'rtx5080',
      device: 'iPhone',
      region: 'US West (San Jose)',
      downlinkMbps: 412,
      latencyMs: 9,
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = Sentry.captureException.mock.calls[0];
    expect(captured).toBeInstanceOf(Error);
    expect(captured.name).toBe('StreamProfileError.unregisteredRig');
    expect(captured.stack).toContain('StreamProfileRegistry.profile(for:device:)');
    expect(context.tags).toMatchObject({
      service: 'customer-315f52fe-ios',
      alert_path: 'instant',
      rig_class: 'rtx5080',
    });
    // Swift frames give Sentry no module path, so the transaction is what
    // ends up in the issue culprit; it must carry the slug for tagless webhooks.
    expect(Sentry.withScope).toHaveBeenCalledTimes(1);
    const scope = Sentry.withScope.mock.results[0].value;
    expect(scope.setTransactionName).toHaveBeenCalledWith('POST /api/315f52fe/ios/error');

    expect(incrementMetric).toHaveBeenCalledWith('play.launch.failure', expect.objectContaining({
      route: '/api/315f52fe/ios/error',
      errorClass: 'StreamProfileError.unregisteredRig',
      tier: 'ultimate',
      rigClass: 'rtx5080',
      device: 'iPhone',
    }));
  });

  test('bounds oversized client strings before they reach Sentry or Slack', () => {
    reportAppFailure({
      ...APP_REPORT,
      errorMessage: 'x'.repeat(2000),
      stackTrace: 'y'.repeat(10000),
      game: 'g'.repeat(500),
    });
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.errorValue).toHaveLength(512);
    expect(alertData.extra.stackTrace).toHaveLength(4000);
    expect(alertData.tags).toEqual(expect.arrayContaining([{ key: 'game', value: 'g'.repeat(64) }]));
  });

  test('the sign-in identity the app sends never redirects ownership away from Shawn', () => {
    const stranger = {
      ...APP_REPORT,
      devinUserId: 'user-abc',
      devinOrgId: 'org-somebody-else',
      devinEmail: 'nobody@nvidia.example',
    };
    reportAppFailure(stranger);
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinUserId).toBe(OWNER.devinUserId);
    expect(alertData.devinOrgId).toBe(ORG_ID);
    expect(alertData.devinEmail).toBe(OWNER.email);
    expect(alertData.slackMemberId).toBe(OWNER.slackMemberId);
    expect(alertData.extra.reporterEmail).toBe('nobody@nvidia.example');
  });

  test('a report carrying no identity is still owned by Shawn', () => {
    const anonymous = { ...APP_REPORT };
    delete anonymous.devinUserId;
    delete anonymous.devinOrgId;
    delete anonymous.devinEmail;
    reportAppFailure(anonymous);
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinUserId).toBe(OWNER.devinUserId);
    expect(alertData.devinOrgId).toBe(ORG_ID);
    expect(alertData.slackMemberId).toBe('U08RSEMUV3L');
    expect(alertData.extra.reporterEmail).toBe('');
  });

  test('one accepted report raises exactly one alert', async () => {
    const { sessionPromise } = reportAppFailure(APP_REPORT);
    await sessionPromise;
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('the directive tells the remediation session to reproduce with reporting off', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('GFN_DISABLE_FAILURE_REPORTS=1');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('exactly one');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('/api/315f52fe/ios/error');
  });

  test('the directive names the Swift repo, the iOS-only surface, and stops before merge', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('Custom-Devin-Demos/nvidia-geforce-now-demo-app');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/iOS only/);
    expect(APP_REMEDIATION_DIRECTIVE).not.toMatch(/flutter|android emulator|hosted web build/i);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('Core/Sources/GeForceNowCore/StreamProfiles.swift');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('RigCatalog.rigClass(for:)');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('Core/Tests/GeForceNowCoreTests/SessionLaunchTests.swift');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('scripts/verify-ios.sh');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('customer-315f52fe-ios');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
  });

  test('Sentry webhook maps the app service tag to the NVIDIA identity', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: 'StreamProfileError.unregisteredRig: No stream profile registered for rig class rtx5080',
      culprit: 'StreamProfileRegistry.profile(for:device:)',
      tags: [
        ['service', 'customer-315f52fe-ios'],
        ['platform', 'ios'],
      ],
    });

    expect(alertData).toMatchObject({
      customer: '315f52fe',
      verticalLabel: 'NVIDIA',
      service: 'customer-315f52fe-ios',
      project: 'geforce-now-ios',
      release: 'geforce-now-ios@1.0.0',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'scenario', value: 'play-ultimate-rig-profile' },
      ['platform', 'ios'],
    ]));
  });

  test('Sentry webhook skips NVIDIA events already alerted by the instant path', () => {
    expect(isInstantPathEvent({
      issueTitle: 'StreamProfileError.unregisteredRig: No stream profile registered for rig class rtx5080',
      culprit: 'POST /api/315f52fe/ios/error',
      tags: [],
    })).toBe(true);
    expect(isInstantPathEvent({
      issueTitle: 'StreamProfileError.unregisteredRig: No stream profile registered for rig class rtx5080',
      culprit: 'StreamProfileRegistry.profile(for:device:)',
      tags: [['service', 'customer-315f52fe-ios'], ['alert_path', 'instant']],
    })).toBe(true);
  });

  test('tagless issue webhook for the captured Swift error is recognized via the transaction culprit', () => {
    const alertData = extractAlertData({
      action: 'created',
      data: {
        issue: {
          id: '4242',
          title: 'StreamProfileError.unregisteredRig: No stream profile registered for rig class rtx5080 (GeForce RTX 5080 SuperPOD) on iPhone',
          culprit: 'POST /api/315f52fe/ios/error',
          metadata: {
            type: 'StreamProfileError.unregisteredRig',
            value: 'No stream profile registered for rig class rtx5080 (GeForce RTX 5080 SuperPOD) on iPhone',
          },
          permalink: 'https://sentry-org.sentry.io/issues/4242/',
        },
      },
    });
    expect(alertData.tags).toEqual([]);
    expect(isInstantPathEvent(alertData)).toBe(true);
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

    test('POST /api/315f52fe/ios/error accepts an app report with 202 and a reference', async () => {
      const { status, body } = await postJson(server, '/api/315f52fe/ios/error', APP_REPORT);

      expect(status).toBe(202);
      expect(body).toMatchObject({
        received: true,
        status: 'accepted',
        service: 'customer-315f52fe-ios',
        sessionRequested: true,
      });
      expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);
      expect(body.receivedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects reports that do not carry the GeForce NOW app identity', async () => {
      for (const bad of [
        { ...APP_REPORT, source: 'nordstrom-shop/ios' },
        { ...APP_REPORT, service: 'customer-5b7227b4-mobile' },
        {},
      ]) {
        const { status, body } = await postJson(server, '/api/315f52fe/ios/error', bad);
        expect(status).toBe(400);
        expect(body.received).toBe(false);
        expect(body.status).toBe('rejected');
      }
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('throttles accepted reports with 429 once the per-route window is full', async () => {
      const { reserveReportSlot } = require('../app/routes/verticals/315f52fe');
      const now = Date.now();
      while (reserveReportSlot(now)) { /* fill the window */ }

      const { status, body } = await postJson(server, '/api/315f52fe/ios/error', APP_REPORT);
      expect(status).toBe(429);
      expect(body).toMatchObject({ received: false, status: 'throttled' });
      expect(createSessionAndAlert).not.toHaveBeenCalled();

      // Slots free up once the window has slid past the burst.
      expect(reserveReportSlot(now + 11 * 60 * 1000)).toBe(true);
    });

    test('answers the CORS preflight for a harness posting from another origin', async () => {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/315f52fe/ios/error`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:8080', 'access-control-request-method': 'POST' },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-methods')).toContain('POST');
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });
  });
});
