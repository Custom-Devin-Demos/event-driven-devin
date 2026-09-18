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
}));

const fs = require('fs');
const http = require('http');
const express = require('express');
const vm = require('vm');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const {
  APP_REMEDIATION_DIRECTIVE,
  reportAppFailure,
} = require('../app/services/verticals/a75ccde9');
const router = require('../app/routes/verticals/a75ccde9');
const { applyCustomerIdentity, isInstantPathEvent } = require('../app/routes/sentry-webhook');

const APP_REPORT = {
  source: 'plan-page-web/browser',
  service: 'customer-a75ccde9-web',
  release: 'a75ccde9-web@1.0.0',
  environment: 'prod',
  platform: 'web',
  screen: 'plan_change',
  action: 'toggle_annual_billing',
  planCode: 'PLUS-24',
  billing: 'annual',
  errorType: 'TypeError',
  errorMessage: "Cannot read properties of undefined (reading 'amount')",
  stackTrace: 'renderPlanPricing (a75ccde9.html:701)',
  devinUserId: 'user-abc',
  devinOrgId: 'org-abc',
  devinEmail: 'yubin.jee@cognition.ai',
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

describe('browser pricing failure report (a75ccde9)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    Sentry.withScope.mockClear();
  });

  test('raises the alert under the page identity', () => {
    const { reference } = reportAppFailure(APP_REPORT);

    expect(reference).toMatch(/^[0-9a-f-]{36}$/);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({
      customer: 'a75ccde9',
      service: 'customer-a75ccde9-web',
      promptAppendix: expect.stringContaining('a75ccde9.html'),
      culprit: 'app/public/verticals/a75ccde9.html — renderPlanPricing',
      devinEmail: 'yubin.jee@cognition.ai',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.withScope.mock.results[0].value.setTransactionName)
      .toHaveBeenCalledWith('POST /api/a75ccde9/error');
  });

  test('maps the customer identity and instant path', () => {
    expect(applyCustomerIdentity({
      issueTitle: 'pricing failed',
      culprit: 'app/public/verticals/a75ccde9.html — renderPlanPricing',
      tags: [['service', 'customer-a75ccde9-web']],
    })).toMatchObject({
      customer: 'a75ccde9',
      verticalLabel: 'FOX One',
      service: 'customer-a75ccde9-web',
      project: 'event-driven-devin',
      release: 'a75ccde9-web@1.0.0',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
    });
    expect(isInstantPathEvent({
      culprit: 'POST /api/a75ccde9/error',
      tags: [],
    })).toBe(true);
  });

  describe('POST /api/a75ccde9/error', () => {
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

    test('rejects the wrong source', async () => {
      const response = await postJson(server, '/api/a75ccde9/error', {
        ...APP_REPORT,
        source: 'other-page/browser',
      });
      expect(response.status).toBe(400);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('rejects the wrong service', async () => {
      const response = await postJson(server, '/api/a75ccde9/error', {
        ...APP_REPORT,
        service: 'other-service',
      });
      expect(response.status).toBe(400);
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });

    test('accepts a valid report with a reference', async () => {
      const response = await postJson(server, '/api/a75ccde9/error', APP_REPORT);
      expect(response.status).toBe(202);
      expect(response.body).toMatchObject({
        received: true,
        reference: expect.stringMatching(/^[0-9a-f-]{36}$/),
        service: 'customer-a75ccde9-web',
      });
      expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    });
  });
});

describe('a75ccde9 page pricing data', () => {
  const page = fs.readFileSync(
    require.resolve('../app/public/verticals/a75ccde9.html'),
    'utf8',
  );
  const match = page.match(/const PLAN_PRICING = (\{[\s\S]*?\n      \};)/);
  const pricing = vm.runInNewContext(`(${match[1].slice(0, -1)})`);

  test('keeps monthly pricing complete while the default annual data is pending', () => {
    expect(Object.keys(pricing)).toEqual(['PLUS-24', 'ULTRA-36', 'FAMILY-PLUS-12']);
    expect(Object.values(pricing).every(({ monthly }) => monthly && monthly.amount && monthly.label)).toBe(true);
    expect(pricing['PLUS-24'].annual).toBeUndefined();
    expect(pricing['ULTRA-36'].annual).toEqual(expect.objectContaining({ amount: expect.any(Number) }));
    expect(pricing['FAMILY-PLUS-12'].annual).toEqual(expect.objectContaining({ amount: expect.any(Number) }));
  });

  test.skip('future remediation requires annual pricing for every offered plan', () => {
    expect(Object.values(pricing).every(({ monthly, annual }) => (
      monthly && monthly.amount && monthly.label && annual && annual.amount && annual.label
    ))).toBe(true);
  });
});
