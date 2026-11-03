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

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const express = require('express');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const {
  CYTRIC_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  APP_SERVICE,
  ERROR_CODE,
  IOS_ERROR_PATH,
  isAppReport,
} = require('../app/services/verticals/amadeus-cytric');
const router = require('../app/routes/verticals/amadeus-cytric');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const customer = require('../config/customers/6571dc84');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', '6571dc84.html'), 'utf8');

const WEB_REPORT = {
  source: 'amadeus-cytric/web',
  service: APP_SERVICE,
  platform: 'web',
  screen: 'TripRequestApproval',
  action: 'approveTripRequest',
  errorType: 'ApprovalError.cabinRuleNotFound(cabin: "premium_economy", policy: "EU-SHORT-HAUL")',
  errorMessage: 'No travel policy rule for cabin premium_economy (trip request TR-48213, policy EU-SHORT-HAUL)',
  errorCode: 'CYT-APR-4221',
  requestId: 'TR-48213',
  tripTitle: "15/12/2026 - NCE, Nice Côte d'Azur",
  traveler: 'Claire Martin',
  cabin: 'premium_economy',
  policy: 'EU-SHORT-HAUL',
  approver: 'Sophie Laurent',
  total: '1184.60 EUR',
  appVersion: '22.9.8',
  devinUserId: '',
  devinEmail: '',
  devinOrgId: '',
};

/** Evaluates the page's travel policy rules (no DOM) so the planted defect is tested as code. */
function loadTravelPolicy() {
  const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];
  const requests = script.slice(script.indexOf('var TRIP_REQUESTS'), script.indexOf('/* Travel policy rules'));
  const rules = script.slice(script.indexOf('var CABIN_LABELS'), script.indexOf('/* end travel policy rules */'));
  const sandbox = {};
  vm.runInNewContext(`${requests}\n${rules}\nthis.approveTripRequest = approveTripRequest; this.TRIP_REQUESTS = TRIP_REQUESTS;`, sandbox);
  return sandbox;
}

async function postJson(server, body) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${IOS_ERROR_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('Amadeus Cytric web replica (/cytric)', () => {
  test('is reachable at the friendly aliases', () => {
    expect(customer.aliases).toEqual(expect.arrayContaining(['cytric', 'amadeus-cytric', 'amadeus']));
  });

  test('reports with the Cytric client identity and supports ?reports=off', () => {
    expect(PAGE).toContain("var REPORT_PATH = '/api/amadeus/cytric/error';");
    expect(PAGE).toContain("source: 'amadeus-cytric/web'");
    expect(PAGE).toContain("service: 'customer-amadeus-cytric'");
    expect(PAGE).toContain("get('reports') !== 'off'");
    expect(PAGE).not.toMatch(/@cognition\.ai|org_[A-Za-z0-9]{8,}/);
  });

  test('shows a red error banner and modal on the failed approval', () => {
    expect(PAGE).toMatch(/--red: #d0021b/);
    expect(PAGE).toContain('data-testid="approval-error"');
    expect(PAGE).toContain('id="error-modal"');
    expect(PAGE).toContain('Approval failed');
  });

  test('keeps the planted defect: Premium Economy has no travel policy cabin rule', () => {
    const { approveTripRequest, TRIP_REQUESTS } = loadTravelPolicy();
    const [nice, madrid] = TRIP_REQUESTS;

    expect(nice.id).toBe('TR-48213');
    expect(() => approveTripRequest(nice)).toThrow(/No travel policy rule for cabin premium_economy/);
    expect(approveTripRequest(madrid)).toMatchObject({ requestId: 'TR-48207', status: 'Approved' });
  });
});

describe('Amadeus Cytric failure report bridge', () => {
  let server;

  beforeAll((done) => {
    const app = express();
    app.use(express.json());
    app.use(router);
    server = app.listen(0, done);
  });

  afterAll((done) => { server.close(done); });

  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('accepts web, ios and android sources only', () => {
    expect(isAppReport(WEB_REPORT)).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'amadeus-cytric/ios' })).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'amadeus-cytric/android' })).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'amadeus-cytric/watch' })).toBe(false);
    expect(isAppReport({ ...WEB_REPORT, service: 'customer-amdocs-nwm' })).toBe(false);
  });

  test('rejects reports with the wrong identity', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'amdocs-nwm/web' });
    expect(status).toBe(400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('raises one Slack alert that starts a Linux orchestrator fanning out to macOS (iOS), Linux (Android) and Linux (web) children', async () => {
    const { status, body } = await postJson(server, WEB_REPORT);
    expect(status).toBe(202);
    expect(body).toMatchObject({ received: true, service: APP_SERVICE, sessionRequested: true });

    await new Promise((resolve) => { setImmediate(resolve); });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData).toMatchObject({
      service: APP_SERVICE,
      customer: '6571dc84',
      sessionPlatform: 'linux',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
      skipVulnerablePr: true,
      title: `[Amadeus Cytric] ${ERROR_CODE} Approve failed for premium_economy trip request (web)`,
    });
    expect(alertData.verticalLabel).toContain('Amadeus Cytric');
    expect(alertData.extra).toMatchObject({ requestId: 'TR-48213', cabin: 'premium_economy', platform: 'web' });
    expect(isInstantPathEvent(alertData)).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('labels Android reports as Android', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'amadeus-cytric/android', platform: 'android' });
    expect(status).toBe(202);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(createSessionAndAlert.mock.calls[0][0].verticalLabel).toBe('Amadeus Cytric — Trip request Approve (Android)');
  });

  test('the orchestrator prompt routes each platform to the right VM and repo', () => {
    expect(CYTRIC_SESSION_PLATFORM).toBe('linux');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*macOS\* child for `COG-GTM\/event-driven-ios`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Linux\* child for `COG-GTM\/event-driven-devin`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Linux\* child for `COG-GTM\/android-demos`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/create THREE child/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('CytricCore/');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('?reports=off');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('[DEMO — DO NOT MERGE]');
  });
});
