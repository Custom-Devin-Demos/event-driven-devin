jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/services/devin-api', () => ({
  listOrgUsers: jest.fn(() => Promise.resolve([
    { user_id: 'nextera-member-1', email: 'Member@NextEra.example' },
  ])),
  listEnterpriseAdmins: jest.fn(() => Promise.resolve([
    { user_id: 'ent-admin-1', email: 'admin@enterprise.example' },
  ])),
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
const { listOrgUsers, listEnterpriseAdmins } = require('../app/services/devin-api');
const { Sentry } = require('../app/telemetry/sentry');
const { incrementMetric } = require('../app/telemetry/datadog');
const {
  reportAppFailure,
  APP_REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/b425648c');
const router = require('../app/routes/verticals/b425648c');
const { getCustomerConfig } = require('../config/customers');
const { applyCustomerIdentity } = require('../app/routes/sentry-webhook');

const ORG_ID = 'org-d1272f315dd0468799fdd54fb0d843a6';

const APP_REPORT = {
  source: 'fpl-my-account/web',
  service: 'customer-b425648c-mobile',
  release: 'fpl-my-account@1.0.0',
  environment: 'prod',
  platform: 'web',
  errorType: 'TypeError',
  errorMessage: 'Null check operator used on a null value',
  stackTrace: 'estimateRestoration (lib/domain/outage_report.dart:88)\nbuildOutageTicket (lib/domain/outage_report.dart:101)',
  screen: 'outage_report',
  action: 'submit_outage_report',
  accountNumber: '0123456798',
  premiseId: 'PRM-7781-JUP',
  circuitType: 'storm_secure_underground',
  problem: 'no_power',
  sentryEventId: 'a1b2c3',
  devinUserId: 'user-abc',
  devinOrgId: ORG_ID,
  devinEmail: 'hub.user@example.com',
  report: {
    accountNumber: '0123456798',
    problem: 'no_power',
    contactPhone: '5615550142',
    updateChannel: 'text',
    note: '',
    nested: { deep: true },
  },
};

const OUTAGE_TICKET = {
  source: 'fpl-my-account/android',
  ticketNumber: 'OUT-4F2A91C7',
  accountNumber: '0123456780',
  premiseId: 'PRM-2210-PBG',
  circuitType: 'overhead',
  problem: 'no_power',
  crew: 'troubleTruck',
  windowStart: '2026-09-15T14:00:00.000Z',
  windowEnd: '2026-09-15T16:30:00.000Z',
  customersAffected: 1,
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

describe('FPL My Account app failure report (b425648c)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    incrementMetric.mockClear();
    listOrgUsers.mockClear();
    listEnterpriseAdmins.mockClear();
  });

  test('customer config targets Custom-Devin-Demos via the API trigger with friendly aliases', () => {
    const config = getCustomerConfig('b425648c');
    expect(config.label).toBe('FPL (NextEra Energy)');
    expect(config.githubOrg).toBe('Custom-Devin-Demos');
    expect(config.triggerMode).toBe('api');
    expect(require('../config/customers/b425648c').aliases).toEqual(['fpl', 'nextera']);
  });

  test('reportAppFailure raises the alert under the app identity with the hub-selected user', () => {
    const { reference } = reportAppFailure(APP_REPORT);

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];

    expect(alertData).toMatchObject({
      customer: 'b425648c',
      service: 'customer-b425648c-mobile',
      verticalLabel: 'FPL',
      project: 'fpl-my-account',
      release: 'fpl-my-account@1.0.0',
      platform: 'web',
      errorType: 'TypeError',
      errorValue: 'Null check operator used on a null value',
      culprit: 'lib/domain/outage_report.dart \u2014 estimateRestoration',
      devinUserId: 'user-abc',
      devinOrgId: ORG_ID,
      devinEmail: 'hub.user@example.com',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'service', value: 'customer-b425648c-mobile' },
      { key: 'platform', value: 'web' },
      { key: 'screen', value: 'outage_report' },
      { key: 'action', value: 'submit_outage_report' },
      { key: 'account_number', value: '0123456798' },
      { key: 'circuit_type', value: 'storm_secure_underground' },
      { key: 'problem', value: 'no_power' },
      { key: 'scenario', value: 'outage-report-restoration' },
    ]));
    expect(alertData.extra.reference).toBe(reference);
    expect(alertData.extra.sentryEventId).toBe('a1b2c3');
    expect(alertData.extra.outageReport).toEqual({
      accountNumber: '0123456798',
      problem: 'no_power',
      contactPhone: '5615550142',
      updateChannel: 'text',
      note: '',
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = Sentry.captureException.mock.calls[0];
    expect(captured.name).toBe('TypeError');
    expect(context.tags.service).toBe('customer-b425648c-mobile');
    expect(context.tags.circuit_type).toBe('storm_secure_underground');

    expect(incrementMetric).toHaveBeenCalledWith('outage_report.failure', expect.objectContaining({
      errorClass: 'TypeError',
      platform: 'web',
      circuitType: 'storm_secure_underground',
    }));
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

  test('resolves the hub email to a NextEra org member when the client has no user id', async () => {
    const byEmail = { ...APP_REPORT, devinUserId: '', devinEmail: 'member@nextera.example' };
    const { sessionPromise } = reportAppFailure(byEmail);
    await sessionPromise;
    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, {});
    expect(listEnterpriseAdmins).not.toHaveBeenCalled();
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinUserId).toBe('nextera-member-1');
    expect(alertData.devinOrgId).toBe(ORG_ID);
  });

  test('looks members up with the FPL service key when one is configured', async () => {
    process.env.DEVIN_SERVICE_KEY_B425648C = 'cog_fpl_test_key';
    try {
      await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'admin@enterprise.example' }).sessionPromise;
    } finally {
      delete process.env.DEVIN_SERVICE_KEY_B425648C;
    }
    const auth = { apiKey: 'cog_fpl_test_key' };
    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, auth);
    expect(listEnterpriseAdmins).toHaveBeenCalledWith(auth);
  });

  test('falls back to enterprise admins, then to the customer config, for unknown emails', async () => {
    await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'admin@enterprise.example' }).sessionPromise;
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('ent-admin-1');

    await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'nobody@nextera.example' }).sessionPromise;
    expect(createSessionAndAlert.mock.calls[1][0].devinUserId).toBeUndefined();
    expect(createSessionAndAlert.mock.calls[1][0].devinEmail).toBe('nobody@nextera.example');
  });

  test('the directive names the Flutter repo, the registry, all three surfaces, and stops before merge', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('Custom-Devin-Demos/fpl-my-account-demo-app');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/Reproduce on web first/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('lib/domain/circuits.dart');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('restorationProfiles');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('test/domain/restoration_test.dart');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('scripts/verify-native.sh android');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('scripts/verify-native.sh ios');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('SAME commit SHA');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('app/public/verticals/b425648c-app/');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
  });

  test('Sentry webhook maps the app service tag to the FPL identity', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: 'TypeError: Null check operator used on a null value',
      culprit: 'estimateRestoration',
      tags: [
        ['service', 'customer-b425648c-mobile'],
        ['platform', 'ios'],
      ],
    });

    expect(alertData).toMatchObject({
      customer: 'b425648c',
      verticalLabel: 'FPL',
      service: 'customer-b425648c-mobile',
      project: 'fpl-my-account',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'scenario', value: 'outage-report-restoration' },
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
      server.closeAllConnections();
      server.close(done);
    });

    test('POST /api/b425648c/mobile/error accepts an app report with 202 and a reference', async () => {
      const { status, body } = await postJson(server, '/api/b425648c/mobile/error', APP_REPORT);

      expect(status).toBe(202);
      expect(body).toMatchObject({
        received: true,
        service: 'customer-b425648c-mobile',
        sessionRequested: true,
      });
      expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects reports that do not carry the FPL app identity', async () => {
      const { status, body } = await postJson(server, '/api/b425648c/mobile/error', {
        ...APP_REPORT,
        source: 'nordstrom-shop/web',
      });

      expect(status).toBe(400);
      expect(body.received).toBe(false);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('POST /api/b425648c/outage/report registers an on-device ticket without alerting', async () => {
      const { status, body } = await postJson(server, '/api/b425648c/outage/report', OUTAGE_TICKET);

      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, status: 'received', ticketNumber: 'OUT-4F2A91C7' });
      expect(createSessionAndAlert).not.toHaveBeenCalled();
      expect(incrementMetric).toHaveBeenCalledWith('outage_report.success', expect.objectContaining({
        platform: 'android',
        circuitType: 'overhead',
      }));
    });

    test('rejects outage tickets missing the account or problem', async () => {
      const { status, body } = await postJson(server, '/api/b425648c/outage/report', {
        source: 'fpl-my-account/web',
        premiseId: 'PRM-2210-PBG',
      });

      expect(status).toBe(400);
      expect(body.success).toBe(false);
    });

    test('answers the CORS preflight for dev builds on another origin', async () => {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/b425648c/mobile/error`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:8080', 'access-control-request-method': 'POST' },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-headers')).toContain('x-fpl-my-account-client');
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('redirects the friendly entry points to the hosted web build', async () => {
      const { port } = server.address();
      for (const entry of ['/fpl-app', '/fplapp', '/fpl/my-account']) {
        const res = await fetch(`http://127.0.0.1:${port}${entry}`, { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/b425648c/app/');
      }
    });

    test('serves the hosted web build and falls back to index.html for deep links', async () => {
      const { port } = server.address();
      const index = await fetch(`http://127.0.0.1:${port}/b425648c/app/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('<base href="/b425648c/app/">');

      const deep = await fetch(`http://127.0.0.1:${port}/b425648c/app/outages/report`);
      expect(deep.status).toBe(200);
      expect(deep.headers.get('content-type')).toContain('text/html');
    });

    test('hosted web build assets revalidate on every load', async () => {
      const { port } = server.address();
      for (const asset of ['/b425648c/app/', '/b425648c/app/main.dart.js', '/b425648c/app/outages/report']) {
        const res = await fetch(`http://127.0.0.1:${port}${asset}`);
        expect(res.status).toBe(200);
        expect(res.headers.get('cache-control')).toBe('no-cache');
      }
    });

    test('entry scripts carry a per-build version so a deploy busts the CDN and browser caches', async () => {
      const { port } = server.address();
      const index = await (await fetch(`http://127.0.0.1:${port}/b425648c/app/`)).text();
      const [, version] = index.match(/src="flutter_bootstrap\.js\?v=([0-9a-f]{12})"/);
      expect(version).toBeDefined();

      const bootstrap = await fetch(`http://127.0.0.1:${port}/b425648c/app/flutter_bootstrap.js?v=${version}`);
      expect(bootstrap.status).toBe(200);
      expect(bootstrap.headers.get('content-type')).toContain('javascript');
      expect(await bootstrap.text()).toContain(`"mainJsPath":"main.dart.js?v=${version}"`);

      const main = await fetch(`http://127.0.0.1:${port}/b425648c/app/main.dart.js?v=${version}`);
      expect(main.status).toBe(200);
    });
  });
});
