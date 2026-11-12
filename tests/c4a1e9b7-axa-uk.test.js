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
  AXA_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  APP_SERVICE,
  ERROR_CODE,
  REPORT_PATH,
  isAppReport,
} = require('../app/services/verticals/axa-uk');
const router = require('../app/routes/verticals/axa-uk');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const customer = require('../config/customers/c4a1e9b7');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', 'c4a1e9b7.html'), 'utf8');

const DRIVER = { firstName: 'James', lastName: 'Carter', dob: '14/03/1986', postcode: 'M20 2LS', licence: 'FULL_UK', ncdYears: '7' };

const WEB_REPORT = {
  source: 'axa-car/web',
  service: APP_SERVICE,
  platform: 'web',
  screen: 'Your quote',
  action: 'getQuote',
  errorType: 'QuoteRatingError',
  errorKind: 'fuelTypeNotRated',
  errorMessage: 'No rating factor for fuel type ELECTRICITY (vehicle LK24 ***, cover COMPREHENSIVE)',
  errorCode: 'AXA-QTE-4221',
  registrationMasked: 'LK24 ***',
  fuelType: 'ELECTRICITY',
  coverType: 'COMPREHENSIVE',
  channel: 'web',
  ratingVersion: '2026-11',
  appVersion: '2026.11.0',
  devinUserId: '',
  devinEmail: '',
  devinOrgId: '',
};

/** Evaluates the page's quote rating rules (no DOM) so the planted defect is tested as code. */
function loadQuoteRules() {
  const rules = PAGE.slice(PAGE.indexOf('/* QUOTE_RATING:start'), PAGE.indexOf('/* QUOTE_RATING:end */'));
  const sandbox = {};
  vm.runInNewContext(`${rules}\nthis.calculateQuote = calculateQuote; this.QuoteRatingError = QuoteRatingError; this.QuoteValidationError = QuoteValidationError;`, sandbox);
  return sandbox;
}

async function postJson(server, body) {
  const { port } = server.address();
  const response = await fetch(`http://127.0.0.1:${port}${REPORT_PATH}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

describe('AXA UK comprehensive car insurance quote replica (/axa)', () => {
  test('is reachable at the friendly aliases', () => {
    expect(customer.aliases).toEqual(expect.arrayContaining(['axa', 'axa-uk']));
  });

  test('walks from the front page through comprehensive car insurance to the quote', () => {
    expect(PAGE).toContain('id="view-home"');
    expect(PAGE).toContain('Insurance quotes from AXA UK');
    expect(PAGE).toContain('id="mega-comprehensive"');
    expect(PAGE).toContain('id="view-comprehensive-car-insurance"');
    expect(PAGE).toContain('Comprehensive Car Insurance Cover with AXA');
    expect(PAGE).toContain('id="comp-get-quote"');
    expect(PAGE).toContain('id="view-quote"');
    expect(PAGE).toContain('id="get-quote"');
  });

  test('reports with the AXA UK client identity and supports ?reports=off', () => {
    expect(PAGE).toContain("var REPORT_PATH = '/api/axa/car-quote/error';");
    expect(PAGE).toContain("var REPORT_SOURCE_PREFIX = 'axa-car/';");
    expect(PAGE).toContain("var REPORT_SERVICE = 'customer-axa-uk';");
    expect(PAGE).toContain("get('reports') !== 'off'");
    expect(PAGE).not.toMatch(/@cognition\.ai|org_[A-Za-z0-9]{8,}/);
  });

  test('is labelled as a mock not affiliated with AXA', () => {
    expect(PAGE).toContain('class="mockbar"');
    expect(PAGE).toContain('THIS IS A MOCK');
    expect(PAGE).toContain('Not affiliated with AXA UK');
    expect(PAGE).toContain('Do not enter real personal details.');
  });

  test('petrol and diesel cars get a quote', () => {
    const { calculateQuote } = loadQuoteRules();
    const petrol = calculateQuote('MA21 PTR', DRIVER, 'COMPREHENSIVE');
    const diesel = calculateQuote('yd19dsl', DRIVER, 'TPFT');
    expect(petrol.annual).toBeGreaterThan(0);
    expect(petrol.plus).toBeCloseTo(petrol.annual + 86, 2);
    expect(diesel.cover).toBe('TPFT');
  });

  test('bad input is an inline validation error, not a rating failure', () => {
    const { calculateQuote, QuoteValidationError } = loadQuoteRules();
    ['', 'ABC', 'ZZ99 ZZZ'].forEach((reg) => {
      expect(() => calculateQuote(reg, DRIVER, 'COMPREHENSIVE')).toThrow(QuoteValidationError);
    });
    expect(() => calculateQuote('MA21 PTR', { ...DRIVER, postcode: 'nope' }, 'COMPREHENSIVE')).toThrow(QuoteValidationError);
    expect(() => calculateQuote('MA21 PTR', { ...DRIVER, dob: '1986-03-14' }, 'COMPREHENSIVE')).toThrow(QuoteValidationError);
    for (const dob of ['31/02/1986', '14/13/1986', '00/03/1986', '14/03/2999']) {
      expect(() => calculateQuote('LK24 EVX', { ...DRIVER, dob }, 'COMPREHENSIVE')).toThrow(QuoteValidationError);
    }
  });

  test('keeps the planted defect: the seeded electric car has no rating factor', () => {
    const { calculateQuote, QuoteRatingError } = loadQuoteRules();
    let error;
    try { calculateQuote('LK24 EVX', DRIVER, 'COMPREHENSIVE'); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(QuoteRatingError);
    expect(error.message).toBe('No rating factor for fuel type ELECTRICITY (vehicle LK24 ***, cover COMPREHENSIVE)');
    expect(error.code).toBe(ERROR_CODE);
  });
});

describe('AXA UK car quote failure report bridge', () => {
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

  test('accepts web, ios and windows sources only', () => {
    expect(isAppReport(WEB_REPORT)).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'axa-car/ios' })).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'axa-car/windows' })).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'axa-car/android' })).toBe(false);
    expect(isAppReport({ ...WEB_REPORT, service: 'customer-bank-millennium' })).toBe(false);
  });

  test('rejects reports with the wrong identity', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'bank-millennium/web' });
    expect(status).toBe(400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('raises one Slack alert that starts a Linux orchestrator', async () => {
    const { status, body } = await postJson(server, WEB_REPORT);
    expect(status).toBe(202);
    expect(body).toMatchObject({ received: true, service: APP_SERVICE, sessionRequested: true });

    await new Promise((resolve) => { setImmediate(resolve); });
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alertData = createSessionAndAlert.mock.calls[0][0];
    expect(alertData).toMatchObject({
      service: APP_SERVICE,
      customer: 'c4a1e9b7',
      sessionPlatform: 'linux',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
      skipVulnerablePr: true,
      title: `[AXA UK] ${ERROR_CODE} car quote failed for fuel type ELECTRICITY (web)`,
    });
    expect(alertData.extra).toMatchObject({ fuelType: 'ELECTRICITY', registrationMasked: 'LK24 ***', platform: 'web' });
    expect(isInstantPathEvent(alertData)).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('labels Windows reports as Windows', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'axa-car/windows', platform: 'windows' });
    expect(status).toBe(202);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(createSessionAndAlert.mock.calls[0][0].verticalLabel).toBe('AXA UK — comprehensive car insurance quote (Windows)');
  });

  test('the orchestrator prompt routes each platform to the right VM and folder', () => {
    expect(AXA_SESSION_PLATFORM).toBe('linux');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*macOS\* child for `COG-GTM\/event-driven-ios`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Windows\* child for `COG-GTM\/event-driven-devin` \(`windows\/AxaCarQuote\/` only\)/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Linux\* child for `COG-GTM\/event-driven-devin`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/create THREE child/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('?reports=off');
    const directive = APP_REMEDIATION_DIRECTIVE;
    expect(directive.indexOf('Devin session link')).toBeLessThan(directive.indexOf('1. Diagnose'));
    expect(directive).toMatch(/new incident even if the same error has alerted before/);
    expect(directive).not.toMatch(/planted|replica/);
  });
});
