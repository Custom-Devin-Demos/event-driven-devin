jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/services/devin-api', () => ({
  listOrgUsers: jest.fn(() => Promise.resolve([
    { user_id: 'owner-user-1', email: 'Roshan.Fernando@cognition.ai' },
    { user_id: 'member-1', email: 'member@capitaliq.example' },
  ])),
  listEnterpriseAdmins: jest.fn(() => Promise.resolve([
    { user_id: 'ent-admin-1', email: 'admin@enterprise.example' },
  ])),
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
const { listOrgUsers, listEnterpriseAdmins } = require('../app/services/devin-api');
const { Sentry } = require('../app/telemetry/sentry');
const {
  reportAppFailure,
  APP_REMEDIATION_DIRECTIVE,
  OWNER,
} = require('../app/services/verticals/c28a3fe9');
const router = require('../app/routes/verticals/c28a3fe9');
const { getCustomerConfig } = require('../config/customers');
const { applyCustomerIdentity, isInstantPathEvent } = require('../app/routes/sentry-webhook');

const ORG_ID = 'org_69IXJFLrljx8zSAw';

const APP_REPORT = {
  source: 'capital-iq/web',
  service: 'customer-c28a3fe9-web',
  release: 'capital-iq-demo@0.1.0',
  environment: 'production',
  platform: 'web',
  widget: 'global-indices',
  action: 'load_index_detail',
  ticker: '^SPX',
  region: 'Americas',
  errorType: 'TypeError',
  errorMessage: "Cannot read properties of undefined (reading 'exchange')",
  stackTrace: 'buildIndexDetail (src/services/indexService.ts:12)',
  devinUserId: 'user-abc',
  devinOrgId: ORG_ID,
  devinEmail: 'hub.user@example.com',
  report: {
    name: 'S&P 500',
    last: 5321.4,
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
        res.on('end', () => resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end(JSON.stringify(body));
  });
}

function get(server, path) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: data, headers: res.headers }));
    }).on('error', reject);
  });
}

describe('S&P Capital IQ Market Monitor failure report (c28a3fe9)', () => {
  const savedOrgId = process.env.DEVIN_ORG_ID;

  beforeEach(() => {
    delete process.env.DEVIN_ORG_ID;
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    Sentry.withScope.mockClear();
    listOrgUsers.mockClear();
    listEnterpriseAdmins.mockClear();
  });

  afterAll(() => {
    if (savedOrgId === undefined) delete process.env.DEVIN_ORG_ID;
    else process.env.DEVIN_ORG_ID = savedOrgId;
  });

  test('customer config targets rdf004 via the API trigger', () => {
    const config = getCustomerConfig('c28a3fe9');
    expect(config.label).toBe('S&P Capital IQ Pro');
    expect(config.githubOrg).toBe('rdf004');
    expect(config.triggerMode).toBe('api');
  });

  test('reportAppFailure raises the alert under the app identity and the demo owner', () => {
    const { reference } = reportAppFailure(APP_REPORT);

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];

    expect(alertData).toMatchObject({
      customer: 'c28a3fe9',
      service: 'customer-c28a3fe9-web',
      verticalLabel: 'S&P Capital IQ Pro',
      project: 'capital-iq-market-monitor',
      release: 'capital-iq-demo@0.1.0',
      platform: 'web',
      errorType: 'TypeError',
      culprit: 'c28a3fe9/src/services/indexService.ts \u2014 buildIndexDetail',
      devinUserId: 'user-abc',
      devinOrgId: ORG_ID,
      devinEmail: 'hub.user@example.com',
      slackMemberId: 'U09SE7WP21F',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'service', value: 'customer-c28a3fe9-web' },
      { key: 'widget', value: 'global-indices' },
      { key: 'ticker', value: '^SPX' },
      { key: 'region', value: 'Americas' },
      { key: 'scenario', value: 'global-indices-detail' },
    ]));
    expect(alertData.extra.report).toEqual({ name: 'S&P 500', last: 5321.4 });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = Sentry.captureException.mock.calls[0];
    expect(captured.name).toBe('TypeError');
    expect(context.tags.alert_path).toBe('instant');
    const scope = Sentry.withScope.mock.results[0].value;
    expect(scope.setTransactionName).toHaveBeenCalledWith('POST /api/c28a3fe9/error');
  });

  test('caps how many report entries reach Sentry and Slack', () => {
    const report = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
    reportAppFailure({ ...APP_REPORT, report });
    expect(Object.keys(createSessionAndAlert.mock.calls[0][0].extra.report)).toHaveLength(24);
  });

  test('an anonymous report is owned by Roshan and resolves him in the default org', async () => {
    process.env.DEVIN_ORG_ID = ORG_ID;
    const anonymous = { ...APP_REPORT };
    delete anonymous.devinUserId;
    delete anonymous.devinOrgId;
    delete anonymous.devinEmail;
    await reportAppFailure(anonymous).sessionPromise;
    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, expect.any(Object));
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(OWNER).toEqual({ slackMemberId: 'U09SE7WP21F', email: 'roshan.fernando@cognition.ai' });
    expect(alertData.devinEmail).toBe(OWNER.email);
    expect(alertData.devinUserId).toBe('owner-user-1');
    expect(alertData.slackMemberId).toBe(OWNER.slackMemberId);
  });

  test('skips the member lookup when no org is known', async () => {
    const anonymous = { ...APP_REPORT, devinUserId: '', devinOrgId: '' };
    await reportAppFailure(anonymous).sessionPromise;
    expect(listOrgUsers).not.toHaveBeenCalled();
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBeUndefined();
  });

  test('resolves the reporter email to an org member when the client has no user id', async () => {
    await reportAppFailure({
      ...APP_REPORT,
      devinUserId: '',
      devinEmail: 'member@capitaliq.example',
    }).sessionPromise;
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('member-1');
  });

  test('falls back to enterprise admins for unknown emails', async () => {
    await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'admin@enterprise.example' }).sessionPromise;
    expect(listEnterpriseAdmins).toHaveBeenCalled();
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('ent-admin-1');
  });

  test('the directive names the Market Monitor repo, the failing path and stops before merge', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('github.com/rdf004/s-and-p-event-driven-demo');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('src/services/indexService.ts');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('src/data/listings.ts');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('app/public/verticals/c28a3fe9-app/');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
  });

  test('Sentry webhook maps the app service tag to the Capital IQ identity', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'exchange')",
      culprit: 'buildIndexDetail',
      tags: [['service', 'customer-c28a3fe9-web'], ['platform', 'web']],
    });

    expect(alertData).toMatchObject({
      customer: 'c28a3fe9',
      verticalLabel: 'S&P Capital IQ Pro',
      service: 'customer-c28a3fe9-web',
      project: 'capital-iq-market-monitor',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
  });

  test('Sentry webhook skips the events the instant path already alerted on, tagged or tagless', () => {
    expect(isInstantPathEvent({
      culprit: 'c28a3fe9/src/services/indexService.ts \u2014 buildIndexDetail',
      tags: [['service', 'customer-c28a3fe9-web'], ['alert_path', 'instant']],
    })).toBe(true);
    expect(isInstantPathEvent({
      culprit: 'POST /api/c28a3fe9/error',
      tags: [],
    })).toBe(true);
  });

  describe('routes', () => {
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

    test('accepts a report from the Market Monitor client', async () => {
      const res = await postJson(server, '/api/c28a3fe9/error', APP_REPORT);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        received: true,
        service: 'customer-c28a3fe9-web',
        sessionRequested: true,
      });
      expect(res.headers['access-control-allow-origin']).toBe('*');
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects a body that does not carry the app identity', async () => {
      const res = await postJson(server, '/api/c28a3fe9/error', { ...APP_REPORT, source: 'other/web' });
      expect(res.status).toBe(400);
      expect(res.body.received).toBe(false);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('serves the hosted build with an SPA fallback and redirects the friendly URLs', async () => {
      const app = await get(server, '/c28a3fe9/app/');
      expect(app.status).toBe(200);
      expect(app.body).toContain('/c28a3fe9/app/assets/');
      expect((await get(server, '/c28a3fe9/app/deep/link')).status).toBe(200);
      for (const entry of ['/c28a3fe9', '/capitaliq', '/capital-iq']) {
        const res = await get(server, entry);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/c28a3fe9/app/');
      }
    });
  });
});
