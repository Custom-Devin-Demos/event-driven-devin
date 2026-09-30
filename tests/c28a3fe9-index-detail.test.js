/* global describe, expect, test, jest, beforeEach, beforeAll, afterAll */
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
  loadIndexDetail,
  REMEDIATION_DIRECTIVE,
  OWNER,
} = require('../app/services/verticals/c28a3fe9');
const { INDICES } = require('../app/services/verticals/c28a3fe9-listings');
const router = require('../app/routes/verticals/c28a3fe9');
const { getCustomerConfig } = require('../config/customers');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const ORG_ID = 'org_69IXJFLrljx8zSAw';
const HUB_USER = {
  devinUserId: 'user-abc',
  devinOrgId: ORG_ID,
  devinEmail: 'hub.user@example.com',
};

function request(server, method, path, body) {
  const { port } = server.address();
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          const json = (res.headers['content-type'] || '').includes('json');
          resolve({ status: res.statusCode, body: json ? JSON.parse(data) : data, headers: res.headers });
        });
      },
    );
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function failureFor(data) {
  try {
    await loadIndexDetail(data);
  } catch (error) {
    await error.sessionPromise;
    return error;
  }
  throw new Error(`expected ${data.ticker} to fail`);
}

describe('S&P Capital IQ Market Monitor index detail (c28a3fe9)', () => {
  const savedOrgId = process.env.DEVIN_ORG_ID;

  beforeEach(() => {
    delete process.env.DEVIN_ORG_ID;
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    listOrgUsers.mockClear();
    listEnterpriseAdmins.mockClear();
  });

  afterAll(() => {
    if (savedOrgId === undefined) delete process.env.DEVIN_ORG_ID;
    else process.env.DEVIN_ORG_ID = savedOrgId;
  });

  test('customer config uses the API trigger', () => {
    const config = getCustomerConfig('c28a3fe9');
    expect(config.label).toBe('S&P Capital IQ Pro');
    expect(config.triggerMode).toBe('api');
  });

  test.each(INDICES.filter((index) => index.region !== 'Americas').map((index) => index.ticker))(
    '%s loads its detail without alerting',
    async (ticker) => {
      const result = await loadIndexDetail({ ticker, ...HUB_USER });
      expect(result.success).toBe(true);
      expect(result.detail).toMatchObject({ ticker, exchange: expect.any(String) });
      expect(['Open', 'Closed']).toContain(result.detail.marketStatus);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    },
  );

  test('an Americas index fails and raises the alert under the hub user', async () => {
    const error = await failureFor({ ticker: '^SPX', ...HUB_USER });

    expect(error.name).toBe('TypeError');
    expect(error.message).toContain("reading 'exchange'");
    expect(error.requestId).toMatch(/^CIQ-[0-9A-F]{8}$/);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, context] = Sentry.captureException.mock.calls[0];
    expect(context.tags).toMatchObject({
      alert_path: 'instant',
      route: '/api/c28a3fe9/index-detail',
      service: 'customer-c28a3fe9-web',
      ticker: '^SPX',
      region: 'Americas',
    });

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData).toMatchObject({
      customer: 'c28a3fe9',
      service: 'customer-c28a3fe9-web',
      verticalLabel: 'S&P Capital IQ Pro',
      errorType: 'TypeError',
      culprit: 'app/services/verticals/c28a3fe9.js \u2014 buildIndexDetail',
      devinUserId: 'user-abc',
      devinOrgId: ORG_ID,
      devinEmail: 'hub.user@example.com',
      slackMemberIdFallback: OWNER.slackMemberId,
      promptAppendix: REMEDIATION_DIRECTIVE,
    });
    expect(alertData.slackMemberId).toBeUndefined();
    expect(alertData.tags).toEqual(expect.arrayContaining([
      { key: 'ticker', value: '^SPX' },
      { key: 'scenario', value: 'global-indices-detail' },
    ]));
    expect(listOrgUsers).not.toHaveBeenCalled();
  });

  test('without a hub sign-in the session belongs to the demo owner', async () => {
    process.env.DEVIN_ORG_ID = ORG_ID;
    await failureFor({ ticker: '^DJI' });
    expect(listOrgUsers).toHaveBeenCalledWith(ORG_ID, expect.any(Object));
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData.devinEmail).toBe(OWNER.email);
    expect(alertData.devinUserId).toBe('owner-user-1');
  });

  test('resolves a hub email to an org member, then an enterprise admin', async () => {
    await failureFor({ ticker: '^SPX', devinOrgId: ORG_ID, devinEmail: 'member@capitaliq.example' });
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBe('member-1');

    await failureFor({ ticker: '^SPX', devinOrgId: ORG_ID, devinEmail: 'admin@enterprise.example' });
    expect(listEnterpriseAdmins).toHaveBeenCalled();
    expect(createSessionAndAlert.mock.calls[1][0].devinUserId).toBe('ent-admin-1');
  });

  test('skips the member lookup when no org is known', async () => {
    await failureFor({ ticker: '^SPX' });
    expect(listOrgUsers).not.toHaveBeenCalled();
    expect(createSessionAndAlert.mock.calls[0][0].devinUserId).toBeUndefined();
  });

  test('an unknown ticker is a validation error with no alert', async () => {
    await expect(loadIndexDetail({ ticker: '^NOPE' })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
      code: 'UNKNOWN_INDEX',
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('the directive points Devin at this repo and the failing files', () => {
    expect(REMEDIATION_DIRECTIVE).toContain('COG-GTM/event-driven-devin');
    expect(REMEDIATION_DIRECTIVE).toContain('app/services/verticals/c28a3fe9.js');
    expect(REMEDIATION_DIRECTIVE).toContain('app/services/verticals/c28a3fe9-listings.js');
    expect(REMEDIATION_DIRECTIVE).toContain('tests/c28a3fe9-index-detail.test.js');
  });

  test('the Sentry webhook skips events the instant path already alerted on', () => {
    expect(isInstantPathEvent({
      culprit: 'app/services/verticals/c28a3fe9.js \u2014 buildIndexDetail',
      tags: [],
    })).toBe(true);
    expect(isInstantPathEvent({
      culprit: 'buildIndexDetail',
      tags: [['alert_path', 'instant']],
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

    test('returns the detail for a Europe index', async () => {
      const res = await request(server, 'POST', '/api/c28a3fe9/index-detail', { ticker: '^DAX' });
      expect(res.status).toBe(200);
      expect(res.body.detail).toMatchObject({ ticker: '^DAX', exchange: 'XETRA' });
    });

    test('answers 500 with the error class for an Americas index', async () => {
      const res = await request(server, 'POST', '/api/c28a3fe9/index-detail', { ticker: '^SPX' });
      expect(res.status).toBe(500);
      expect(res.body).toMatchObject({ success: false, errorClass: 'TypeError', code: 'INDEX_DETAIL_FAILED' });
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });

    test('answers 400 for an unknown index', async () => {
      const res = await request(server, 'POST', '/api/c28a3fe9/index-detail', { ticker: 'X' });
      expect(res.status).toBe(400);
      expect(res.body.code).toBe('UNKNOWN_INDEX');
    });

    test('serves the hosted build with an SPA fallback and redirects the friendly URLs', async () => {
      const app = await request(server, 'GET', '/c28a3fe9/app/');
      expect(app.status).toBe(200);
      expect(app.body).toContain('/c28a3fe9/app/assets/');
      expect((await request(server, 'GET', '/c28a3fe9/app/deep/link')).status).toBe(200);
      for (const entry of ['/c28a3fe9', '/capitaliq', '/capital-iq']) {
        const res = await request(server, 'GET', entry);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe('/c28a3fe9/app/');
      }
    });
  });
});
