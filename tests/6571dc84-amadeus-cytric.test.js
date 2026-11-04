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
  screen: 'trip',
  action: 'open_boarding_pass',
  errorType: 'BookingRetrievalRejected',
  errorMessage: 'CYT-TRP-4031: airline booking retrieval rejected (TRAVELER_VERIFICATION_REQUIRED)',
  errorCode: 'CYT-TRP-4031',
  backendCode: 'TRAVELER_VERIFICATION_REQUIRED',
  backendRequestId: '53ed867a-049b-470a-84a7-3e9658d107a1',
  recordLocator: '6KQ2RT',
  tripId: 'TR-48213',
  airline: 'British Airways',
  appVersion: '26.11.2',
  devinUserId: '',
  devinEmail: '',
  devinOrgId: '',
};

/** Evaluates the page's airline retrieval stub (no DOM) so the planted client behaviour is tested as code. */
function loadAirlineApi() {
  const script = PAGE.match(/<script>([\s\S]*?)<\/script>/)[1];
  const api = script.slice(script.indexOf('var AIRLINE_API'), script.indexOf('/* end airline retrieval api */'));
  const sandbox = { crypto: require('crypto') };
  vm.runInNewContext(`function uuid() { return crypto.randomUUID(); }\n${api}\nthis.AIRLINE_API = AIRLINE_API;`, sandbox);
  return sandbox.AIRLINE_API;
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

  test('shows the red booking error card on the failed boarding pass', () => {
    expect(PAGE).toMatch(/--red:\s*#c62828/);
    expect(PAGE).toContain('data-testid="booking-error"');
    expect(PAGE).toContain('id="trip-boarding-pass"');
    expect(PAGE).toContain("We couldn\\'t open your booking");
    expect(PAGE).toContain("var CLIENT_ERROR_CODE = 'CYT-TRP-4031';");
  });

  test('keeps the planted client behaviour: a locator-only retrieval is refused by the airline API control', () => {
    const api = loadAirlineApi();
    const first = api.retrieve({ recordLocator: '6KQ2RT', channel: 'cytric-web' });
    expect(first.status).toBe(403);
    expect(first.body).toMatchObject({ success: false, code: 'TRAVELER_VERIFICATION_REQUIRED', requestId: expect.any(String) });
    expect(first.body.verification).toMatchObject({ recordLocator: '6KQ2RT', requiredField: 'travelerLastName', token: expect.any(String) });
    expect(JSON.stringify(first.body)).not.toMatch(/Martin|BA 348/);
    expect(api.retrieve({ recordLocator: '6K' }).status).toBe(400);
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
      title: `[Amadeus cytric] ${ERROR_CODE} Boarding pass failed: airline API TRAVELER_VERIFICATION_REQUIRED (web)`,
      repos: ['joao-cognition/demo_webapp', 'joao-cognition/demo_android', 'joao-cognition/demo_ios'],
    });
    expect(alertData.verticalLabel).toContain('Amadeus cytric');
    expect(alertData.extra).toMatchObject({ backendRequestId: WEB_REPORT.backendRequestId, recordLocator: '6KQ2RT', tripId: 'TR-48213', platform: 'web' });
    expect(JSON.stringify(alertData.extra)).not.toMatch(/Martin/);
    expect(isInstantPathEvent(alertData)).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('labels Android reports as Android', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'amadeus-cytric/android', platform: 'android' });
    expect(status).toBe(202);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(createSessionAndAlert.mock.calls[0][0].verticalLabel).toBe('Amadeus cytric — Boarding pass / booking retrieval (Android)');
  });

  test('the lead prompt routes the fix to the three demo repos via the incident skill and never to the hosted repos', () => {
    expect(CYTRIC_SESSION_PLATFORM).toBe('linux');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*macOS\* child for `joao-cognition\/demo_ios`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Linux\* child for `joao-cognition\/demo_android`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Linux\* child for `joao-cognition\/demo_webapp`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/THREE child Devin sessions IN PARALLEL/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('cross-platform-incident-fix');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('SEC-2041');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('Do not clone, change or open PRs in `COG-GTM/event-driven-devin`');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('?reports=off');
    expect(APP_REMEDIATION_DIRECTIVE).toContain('Never merge');
  });
});
