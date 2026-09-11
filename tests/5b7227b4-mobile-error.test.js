jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/services/devin-api', () => ({
  listOrgUsers: jest.fn(() => Promise.resolve([
    { user_id: 'nordstrom-member-1', email: 'Member@Nordstrom.example' },
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
} = require('../app/services/verticals/5b7227b4');
const router = require('../app/routes/verticals/5b7227b4');
const { getCustomerConfig } = require('../config/customers');
const { applyCustomerIdentity } = require('../app/routes/sentry-webhook');

const ORG_ID = 'org-b92933e8dd00477eb9e0b1222b9ab4f9';

const APP_REPORT = {
  source: 'nordstrom-shop/web',
  service: 'customer-5b7227b4-mobile',
  release: 'nordstrom-shop@1.0.0',
  environment: 'prod',
  platform: 'web',
  errorType: 'TypeError',
  errorMessage: 'Null check operator used on a null value',
  stackTrace: '_rewardsForLine (lib/domain/bag_summary.dart:42)\nbuildBagSummary (lib/domain/bag_summary.dart:21)',
  screen: 'product',
  action: 'add_to_bag',
  product: 'hoka-clifton-one9-w',
  priceStatus: 'new_markdown',
  sentryEventId: 'a1b2c3',
  devinUserId: 'user-abc',
  devinOrgId: ORG_ID,
  devinEmail: 'hub.user@example.com',
  bag: {
    product: 'hoka-clifton-one9-w',
    color: 'Black/White',
    size: '8',
    quantity: 1,
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

describe('Nordstrom app failure report (5b7227b4)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    listOrgUsers.mockClear();
    listEnterpriseAdmins.mockClear();
  });

  test('customer config targets Custom-Devin-Demos via the API trigger', () => {
    const config = getCustomerConfig('5b7227b4');
    expect(config.label).toBe('Nordstrom');
    expect(config.githubOrg).toBe('Custom-Devin-Demos');
    expect(config.triggerMode).toBe('api');
  });

  test('reportAppFailure raises the alert under the app identity with the hub-selected user', () => {
    const { reference } = reportAppFailure(APP_REPORT);

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];

    expect(alertData).toMatchObject({
      customer: '5b7227b4',
      service: 'customer-5b7227b4-mobile',
      verticalLabel: 'Nordstrom',
      project: 'nordstrom-shop',
      release: 'nordstrom-shop@1.0.0',
      platform: 'web',
      errorType: 'TypeError',
      errorValue: 'Null check operator used on a null value',
      culprit: 'lib/domain/bag_summary.dart \u2014 buildBagSummary',
      devinUserId: 'user-abc',
      devinOrgId: ORG_ID,
      devinEmail: 'hub.user@example.com',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'service', value: 'customer-5b7227b4-mobile' },
      { key: 'platform', value: 'web' },
      { key: 'screen', value: 'product' },
      { key: 'action', value: 'add_to_bag' },
      { key: 'product', value: 'hoka-clifton-one9-w' },
      { key: 'price_status', value: 'new_markdown' },
      { key: 'scenario', value: 'add-to-bag-rewards' },
    ]));
    expect(alertData.extra.reference).toBe(reference);
    expect(alertData.extra.sentryEventId).toBe('a1b2c3');
    expect(alertData.extra.bag).toEqual({
      product: 'hoka-clifton-one9-w',
      color: 'Black/White',
      size: '8',
      quantity: 1,
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = Sentry.captureException.mock.calls[0];
    expect(captured.name).toBe('TypeError');
    expect(context.tags.service).toBe('customer-5b7227b4-mobile');
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

  test('resolves the hub email to a Nordstrom org member when the client has no user id', async () => {
    const byEmail = { ...APP_REPORT, devinUserId: '', devinEmail: 'member@nordstrom.example' };
    const { sessionPromise } = reportAppFailure(byEmail);
    await sessionPromise;
    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, {});
    expect(listEnterpriseAdmins).not.toHaveBeenCalled();
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinUserId).toBe('nordstrom-member-1');
    expect(alertData.devinOrgId).toBe(ORG_ID);
  });

  test('looks members up with the Nordstrom service key when one is configured', async () => {
    process.env.DEVIN_SERVICE_KEY_5B7227B4 = 'cog_nordstrom_test_key';
    try {
      await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'admin@enterprise.example' }).sessionPromise;
    } finally {
      delete process.env.DEVIN_SERVICE_KEY_5B7227B4;
    }
    const auth = { apiKey: 'cog_nordstrom_test_key' };
    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, auth);
    expect(listEnterpriseAdmins).toHaveBeenCalledWith(auth);
  });

  test('falls back to enterprise admins, then to the customer config, for unknown emails', async () => {
    await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'admin@enterprise.example' }).sessionPromise;
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('ent-admin-1');

    await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'nobody@nordstrom.example' }).sessionPromise;
    expect(createSessionAndAlert.mock.calls[1][0].devinUserId).toBeUndefined();
    expect(createSessionAndAlert.mock.calls[1][0].devinEmail).toBe('nobody@nordstrom.example');
  });

  test('the directive names the Flutter repo, all three surfaces, and stops before merge', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('Custom-Devin-Demos/nordstrom-shopping-demo-app');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/Reproduce on web first/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('test/domain/rewards_earning_test.dart');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('scripts/verify-native.sh android');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('scripts/verify-native.sh ios');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('SAME commit SHA');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('app/public/verticals/5b7227b4-app/');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
  });

  test('Sentry webhook maps the app service tag to the Nordstrom identity', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: 'TypeError: Null check operator used on a null value',
      culprit: 'buildBagSummary',
      tags: [
        ['service', 'customer-5b7227b4-mobile'],
        ['platform', 'android'],
      ],
    });

    expect(alertData).toMatchObject({
      customer: '5b7227b4',
      verticalLabel: 'Nordstrom',
      service: 'customer-5b7227b4-mobile',
      project: 'nordstrom-shop',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'scenario', value: 'add-to-bag-rewards' },
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

    test('POST /api/5b7227b4/mobile/error accepts an app report with 202 and a reference', async () => {
      const { status, body } = await postJson(server, '/api/5b7227b4/mobile/error', APP_REPORT);

      expect(status).toBe(202);
      expect(body).toMatchObject({
        received: true,
        service: 'customer-5b7227b4-mobile',
        sessionRequested: true,
      });
      expect(body.reference).toMatch(/^[0-9a-f-]{36}$/);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects reports that do not carry the Nordstrom app identity', async () => {
      const { status, body } = await postJson(server, '/api/5b7227b4/mobile/error', {
        ...APP_REPORT,
        source: 'citi-mobile/web',
      });

      expect(status).toBe(400);
      expect(body.received).toBe(false);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('POST /api/5b7227b4/bag registers a priced bag without alerting', async () => {
      const { status, body } = await postJson(server, '/api/5b7227b4/bag', {
        source: 'nordstrom-shop/android',
        product: 'zella-live-in-legging',
        quantity: 1,
        itemCount: 1,
        subtotal: 65,
        total: 70.85,
        nordyPoints: 65,
      });

      expect(status).toBe(200);
      expect(body).toMatchObject({ success: true, status: 'synced' });
      expect(body.bagId).toMatch(/^[0-9a-f-]{36}$/);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('answers the CORS preflight for dev builds on another origin', async () => {
      const { port } = server.address();
      const res = await fetch(`http://127.0.0.1:${port}/api/5b7227b4/mobile/error`, {
        method: 'OPTIONS',
        headers: { origin: 'http://localhost:8080', 'access-control-request-method': 'POST' },
      });

      expect(res.status).toBe(204);
      expect(res.headers.get('access-control-allow-origin')).toBe('*');
      expect(res.headers.get('access-control-allow-headers')).toContain('x-nordstrom-shop-client');
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('redirects the friendly entry points to the hosted web build', async () => {
      const { port } = server.address();
      for (const entry of ['/5b7227b4', '/nordstromapp']) {
        const res = await fetch(`http://127.0.0.1:${port}${entry}`, { redirect: 'manual' });
        expect(res.status).toBe(302);
        expect(res.headers.get('location')).toBe('/5b7227b4/app/');
      }
    });

    test('serves the hosted web build and falls back to index.html for deep links', async () => {
      const { port } = server.address();
      const index = await fetch(`http://127.0.0.1:${port}/5b7227b4/app/`);
      expect(index.status).toBe(200);
      expect(await index.text()).toContain('<base href="/5b7227b4/app/">');

      const deep = await fetch(`http://127.0.0.1:${port}/5b7227b4/app/product/hoka-clifton-one9-w`);
      expect(deep.status).toBe(200);
      expect(deep.headers.get('content-type')).toContain('text/html');
    });
  });
});
