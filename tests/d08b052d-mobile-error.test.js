jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/services/devin-api', () => ({
  listOrgUsers: jest.fn(() => Promise.resolve([
    { user_id: 'comed-member-1', email: 'Member@ComEd.example' },
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
const {
  reportAppFailure,
  APP_REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/d08b052d');
const router = require('../app/routes/verticals/d08b052d');
const { getCustomerConfig } = require('../config/customers');
const { applyCustomerIdentity } = require('../app/routes/sentry-webhook');

const ORG_ID = 'org-8c04e28d44a94bd78894e6df1d8ad09f';

const APP_REPORT = {
  source: 'comed-account/web',
  service: 'customer-d08b052d-mobile',
  release: 'comed-account@1.0.0',
  environment: 'prod',
  platform: 'web',
  errorType: 'TypeError',
  errorMessage: 'Null check operator used on a null value',
  stackTrace: 'buildDispatchPlan (lib/domain/outage_report.dart:88)\nbuildOutageTicket (lib/domain/outage_report.dart:120)',
  screen: 'report_outage',
  action: 'report_outage',
  servicePoint: 'sp-damen',
  meterType: 'ami_gen2',
  meterId: 'NG-90514408',
  zip: '60647',
  outageType: 'all_power',
  sentryEventId: 'a1b2c3',
  devinUserId: 'user-abc',
  devinOrgId: ORG_ID,
  devinEmail: 'hub.user@example.com',
  report: {
    servicePoint: 'sp-damen',
    outageType: 'all_power',
    downedWire: false,
    callbackProvided: true,
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

describe('ComEd app failure report (d08b052d)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    listOrgUsers.mockClear();
    listEnterpriseAdmins.mockClear();
  });

  test('customer config targets Custom-Devin-Demos via the API trigger', () => {
    const config = getCustomerConfig('d08b052d');
    expect(config.label).toBe('ComEd');
    expect(config.githubOrg).toBe('Custom-Devin-Demos');
    expect(config.triggerMode).toBe('api');
  });

  test('reportAppFailure raises the alert under the app identity with the hub-selected user', () => {
    const { reference } = reportAppFailure(APP_REPORT);

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];

    expect(alertData).toMatchObject({
      customer: 'd08b052d',
      service: 'customer-d08b052d-mobile',
      verticalLabel: 'ComEd',
      project: 'comed-account',
      release: 'comed-account@1.0.0',
      platform: 'web',
      errorType: 'TypeError',
      errorValue: 'Null check operator used on a null value',
      culprit: 'lib/domain/outage_report.dart \u2014 buildDispatchPlan',
      devinUserId: 'user-abc',
      devinOrgId: ORG_ID,
      devinEmail: 'hub.user@example.com',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'service', value: 'customer-d08b052d-mobile' },
      { key: 'platform', value: 'web' },
      { key: 'screen', value: 'report_outage' },
      { key: 'action', value: 'report_outage' },
      { key: 'service_point', value: 'sp-damen' },
      { key: 'meter_type', value: 'ami_gen2' },
      { key: 'meter_id', value: 'NG-90514408' },
      { key: 'outage_type', value: 'all_power' },
      { key: 'scenario', value: 'report-outage-dispatch' },
    ]));
    expect(alertData.extra.reference).toBe(reference);
    expect(alertData.extra.sentryEventId).toBe('a1b2c3');
    expect(alertData.extra.report).toEqual({
      servicePoint: 'sp-damen',
      outageType: 'all_power',
      downedWire: false,
      callbackProvided: true,
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = Sentry.captureException.mock.calls[0];
    expect(captured.name).toBe('TypeError');
    expect(context.tags.service).toBe('customer-d08b052d-mobile');
    expect(context.tags.alert_path).toBe('instant');
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

  test('resolves the hub email to a ComEd org member when the client has no user id', async () => {
    const byEmail = { ...APP_REPORT, devinUserId: '', devinEmail: 'member@comed.example' };
    const { sessionPromise } = reportAppFailure(byEmail);
    await sessionPromise;
    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, {});
    expect(listEnterpriseAdmins).not.toHaveBeenCalled();
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinUserId).toBe('comed-member-1');
    expect(alertData.devinOrgId).toBe(ORG_ID);
  });

  test('looks members up with the ComEd service key when one is configured', async () => {
    process.env.DEVIN_SERVICE_KEY_D08B052D = 'cog_comed_test_key';
    try {
      await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'admin@enterprise.example' }).sessionPromise;
    } finally {
      delete process.env.DEVIN_SERVICE_KEY_D08B052D;
    }
    const auth = { apiKey: 'cog_comed_test_key' };
    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, auth);
    expect(listEnterpriseAdmins).toHaveBeenCalledWith(auth);
  });

  test('falls back to enterprise admins, then to the customer config, for unknown emails', async () => {
    await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'admin@enterprise.example' }).sessionPromise;
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('ent-admin-1');

    await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'nobody@comed.example' }).sessionPromise;
    expect(createSessionAndAlert.mock.calls[1][0].devinUserId).toBeUndefined();
    expect(createSessionAndAlert.mock.calls[1][0].devinEmail).toBe('nobody@comed.example');
  });

  test('the directive names the Flutter repo, all three surfaces, and stops before merge', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('Custom-Devin-Demos/exelon-utility-demo-app');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/Reproduce on web first/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('test/domain/outage_dispatch_test.dart');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('scripts/verify-native.sh android');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('scripts/verify-native.sh ios');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('SAME commit SHA');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('app/public/verticals/d08b052d-app/');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
  });

  test('Sentry webhook maps the app service tag to the ComEd identity', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: 'TypeError: Null check operator used on a null value',
      culprit: 'buildDispatchPlan',
      tags: [
        ['service', 'customer-d08b052d-mobile'],
        ['platform', 'android'],
      ],
    });

    expect(alertData).toMatchObject({
      customer: 'd08b052d',
      verticalLabel: 'ComEd',
      service: 'customer-d08b052d-mobile',
      project: 'comed-account',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'scenario', value: 'report-outage-dispatch' },
      ['platform', 'android'],
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

    test('POST /api/d08b052d/mobile/error accepts an app report with 202 and a reference', async () => {
      const { status, body } = await postJson(server, '/api/d08b052d/mobile/error', APP_REPORT);

      expect(status).toBe(202);
      expect(body).toMatchObject({
        received: true,
        service: 'customer-d08b052d-mobile',
        sessionRequested: true,
      });
      expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects reports that do not carry the ComEd app identity', async () => {
      const { status, body } = await postJson(server, '/api/d08b052d/mobile/error', {
        ...APP_REPORT,
        source: 'nordstrom-shop/web',
      });

      expect(status).toBe(400);
      expect(body.received).toBe(false);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('POST /api/d08b052d/outages registers an on-device ticket without alerting', async () => {
      const { status, body } = await postJson(server, '/api/d08b052d/outages', {
        source: 'comed-account/android',
        ticketNumber: 'OUT-2609-48213',
        servicePoint: 'sp-everett',
        meterType: 'ami_smart',
        outageType: 'all_power',
        crewType: 'Troubleshooter',
        estimatedRestoration: '2026-09-15T16:30:00.000Z',
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, status: 'synced', ticketNumber: 'OUT-2609-48213' });
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('answers the CORS preflight for dev builds on another origin', async () => {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/d08b052d/mobile/error`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:8080', 'access-control-request-method': 'POST' },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-headers')).toContain('x-comed-account-client');
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('redirects the friendly entry points to the hosted web build', async () => {
      const { port } = server.address();
      for (const entry of ['/d08b052d', '/comed', '/exelon']) {
        const res = await fetch(`http://127.0.0.1:${port}${entry}`, { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/d08b052d/app/');
      }
    });

    test('serves the hosted web build and falls back to index.html for deep links', async () => {
      const { port } = server.address();
      const index = await fetch(`http://127.0.0.1:${port}/d08b052d/app/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('<base href="/d08b052d/app/">');

      const deep = await fetch(`http://127.0.0.1:${port}/d08b052d/app/outages/report?sp=sp-damen`);
      expect(deep.status).toBe(200);
      expect(deep.headers.get('content-type')).toContain('text/html');
    });
  });
});
