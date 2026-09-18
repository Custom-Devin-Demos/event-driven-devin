jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/services/devin-api', () => ({
  listOrgUsers: jest.fn(() => Promise.resolve([
    { user_id: 'nexen-member-1', email: 'Member@Nexen.example' },
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
  OWNER,
} = require('../app/services/verticals/9bfabd45');
const router = require('../app/routes/verticals/9bfabd45');
const { getCustomerConfig } = require('../config/customers');
const { applyCustomerIdentity } = require('../app/routes/sentry-webhook');

const ORG_ID = 'org_69IXJFLrljx8zSAw';

const APP_REPORT = {
  source: 'nexen-custody/web',
  service: 'customer-9bfabd45-web',
  release: 'nexen-custody@1.0.0',
  environment: 'prod',
  platform: 'web',
  errorType: 'TypeError',
  errorMessage: "Cannot read properties of undefined (reading 'safekeepingEntity')",
  stackTrace: 'buildDepositInstruction (src/domain/digitalAssetCustody.ts:48)',
  screen: 'custody_holdings',
  action: 'instruct_digital_asset_deposit',
  accountNumber: '8842933',
  clientName: 'Meridian Asset Management',
  market: 'DE',
  devinUserId: 'user-abc',
  devinOrgId: ORG_ID,
  devinEmail: 'hub.user@example.com',
  report: {
    assetClass: 'digital_asset',
    baseCurrency: 'EUR',
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

describe('BNY NEXEN failure report (9bfabd45)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    listOrgUsers.mockClear();
    listEnterpriseAdmins.mockClear();
  });

  test('customer config targets COG-GTM via the API trigger', () => {
    const config = getCustomerConfig('9bfabd45');
    expect(config.label).toBe('BNY NEXEN');
    expect(config.githubOrg).toBe('COG-GTM');
    expect(config.triggerMode).toBe('api');
  });

  test('reportAppFailure raises the alert under the app identity and the demo owner', () => {
    const { reference } = reportAppFailure(APP_REPORT);

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];

    expect(alertData).toMatchObject({
      customer: '9bfabd45',
      service: 'customer-9bfabd45-web',
      verticalLabel: 'BNY NEXEN',
      project: 'nexen-custody',
      release: 'nexen-custody@1.0.0',
      platform: 'web',
      errorType: 'TypeError',
      culprit: 'frontend/src/domain/digitalAssetCustody.ts \u2014 buildDepositInstruction',
      devinUserId: 'user-abc',
      devinOrgId: ORG_ID,
      devinEmail: 'hub.user@example.com',
      slackMemberId: OWNER.slackMemberId,
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'service', value: 'customer-9bfabd45-web' },
      { key: 'screen', value: 'custody_holdings' },
      { key: 'action', value: 'instruct_digital_asset_deposit' },
      { key: 'account_number', value: '8842933' },
      { key: 'market', value: 'DE' },
      { key: 'scenario', value: 'digital-asset-custody-deposit' },
    ]));
    expect(alertData.extra.report).toEqual({ assetClass: 'digital_asset', baseCurrency: 'EUR' });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [captured, context] = Sentry.captureException.mock.calls[0];
    expect(captured.name).toBe('TypeError');
    expect(context.tags.alert_path).toBe('instant');
  });

  test('falls back to the demo owner email when the client sends no identity', () => {
    const anonymous = { ...APP_REPORT };
    delete anonymous.devinUserId;
    delete anonymous.devinOrgId;
    delete anonymous.devinEmail;
    reportAppFailure(anonymous);
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinEmail).toBe(OWNER.email);
    expect(alertData.slackMemberId).toBe(OWNER.slackMemberId);
  });

  test('resolves the reporter email to an org member when the client has no user id', async () => {
    const { sessionPromise } = reportAppFailure({
      ...APP_REPORT,
      devinUserId: '',
      devinEmail: 'member@nexen.example',
    });
    await sessionPromise;
    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, expect.any(Object));
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('nexen-member-1');
  });

  test('falls back to enterprise admins for unknown emails', async () => {
    await reportAppFailure({ ...APP_REPORT, devinUserId: '', devinEmail: 'admin@enterprise.example' }).sessionPromise;
    expect(listEnterpriseAdmins).toHaveBeenCalled();
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('ent-admin-1');
  });

  test('the directive names the NEXEN repo, the registry fix and stops before merge', () => {
    expect(APP_REMEDIATION_DIRECTIVE).toContain('github.com/COG-GTM/bny');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('frontend/src/domain/digitalAssetCustody.ts');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('DIGITAL_ASSET_CUSTODY_RULES');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('app/public/verticals/9bfabd45-app/');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('STOP for human approval');
  });

  test('Sentry webhook maps the app service tag to the NEXEN identity', () => {
    const alertData = applyCustomerIdentity({
      issueTitle: "TypeError: Cannot read properties of undefined (reading 'safekeepingEntity')",
      culprit: 'buildDepositInstruction',
      tags: [['service', 'customer-9bfabd45-web'], ['platform', 'web']],
    });

    expect(alertData).toMatchObject({
      customer: '9bfabd45',
      verticalLabel: 'BNY NEXEN',
      service: 'customer-9bfabd45-web',
      project: 'nexen-custody',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
  });

  describe('POST /api/9bfabd45/error', () => {
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

    test('accepts a report from the NEXEN client', async () => {
      const res = await postJson(server, '/api/9bfabd45/error', APP_REPORT);
      expect(res.status).toBe(202);
      expect(res.body).toMatchObject({
        received: true,
        service: 'customer-9bfabd45-web',
        sessionRequested: true,
      });
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('rejects a body that does not carry the app identity', async () => {
      const res = await postJson(server, '/api/9bfabd45/error', { ...APP_REPORT, service: 'something-else' });
      expect(res.status).toBe(400);
      expect(res.body.received).toBe(false);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });
  });
});
