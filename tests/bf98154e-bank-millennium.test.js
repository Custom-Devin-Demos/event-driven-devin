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
  BANK_MILLENNIUM_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  APP_SERVICE,
  ERROR_CODE,
  REPORT_PATH,
  isAppReport,
} = require('../app/services/verticals/bank-millennium');
const router = require('../app/routes/verticals/bank-millennium');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const customer = require('../config/customers/bf98154e');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', 'bf98154e.html'), 'utf8');

const WEB_REPORT = {
  source: 'bank-millennium/web',
  service: APP_SERVICE,
  platform: 'web',
  screen: 'Login',
  action: 'signIn',
  errorType: 'SignInPolicyError.segmentNotInPolicy',
  errorMessage: 'No sign-in policy for segment MILLENNIUM_PRESTIGE (Millekod 4821****, channel web)',
  errorCode: 'MIL-AUTH-4031',
  millekodMasked: '4821****',
  segment: 'MILLENNIUM_PRESTIGE',
  channel: 'web',
  policyVersion: '2026-10',
  appVersion: '2026.4.2',
  devinUserId: '',
  devinEmail: '',
  devinOrgId: '',
};

/** Evaluates the page's sign-in rules (no DOM) so the planted defect is tested as code. */
function loadSignInRules() {
  const rules = PAGE.slice(PAGE.indexOf('/* SIGN_IN_POLICIES:start'), PAGE.indexOf('/* SIGN_IN_POLICIES:end */'));
  const sandbox = {};
  vm.runInNewContext(`${rules}\nthis.signIn = signIn; this.SignInPolicyError = SignInPolicyError; this.LoginValidationError = LoginValidationError;`, sandbox);
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

describe('Bank Millennium Millenet login replica (/bankmillennium)', () => {
  test('is reachable at the friendly aliases', () => {
    expect(customer.aliases).toEqual(expect.arrayContaining(['bankmillennium', 'millenet']));
  });

  test('is an English Millenet login page reached from the public site', () => {
    expect(PAGE).toContain('<html lang="en">');
    expect(PAGE).toContain('id="openLogin"');
    expect(PAGE).toContain('Log in to Millenet');
    expect(PAGE).toContain('Millekod');
    expect(PAGE).toContain('id="signIn"');
  });

  test('reports with the Bank Millennium client identity and supports ?reports=off', () => {
    expect(PAGE).toContain("var REPORT_PATH = '/api/bankmillennium/login/error';");
    expect(PAGE).toContain("source: 'bank-millennium/web'");
    expect(PAGE).toContain("service: 'customer-bank-millennium'");
    expect(PAGE).toContain("get('reports') !== 'off'");
    expect(PAGE).not.toMatch(/@cognition\.ai|org_[A-Za-z0-9]{8,}/);
  });

  test('is labelled as a mock not affiliated with Bank Millennium', () => {
    expect(PAGE).toContain('class="mockbar"');
    expect(PAGE).toContain('THIS IS A MOCK');
    expect(PAGE).toContain('not affiliated with Bank Millennium S.A.');
    expect(PAGE).toContain('Do not enter real credentials.');
  });

  test('Standard and Private Banking customers sign in', () => {
    const { signIn } = loadSignInRules();
    expect(signIn('31570264', 'Demo2026!', 'web').policy).toMatchObject({ sessionMinutes: 10 });
    expect(signIn('55018342', 'Demo2026!', 'web').policy).toMatchObject({ sessionMinutes: 15 });
  });

  test('invalid credentials are inline validation errors, not policy failures', () => {
    const { signIn, LoginValidationError } = loadSignInRules();
    ['1234', '4821390a', '99999999'].forEach((millekod) => {
      expect(() => signIn(millekod, 'Demo2026!', 'web')).toThrow(LoginValidationError);
    });
    expect(() => signIn('31570264', '', 'web')).toThrow(LoginValidationError);
    expect(() => signIn('31570264', 'wrong-password', 'web')).toThrow(LoginValidationError);
    expect(() => signIn('55018342', 'demo2026!', 'web')).toThrow(LoginValidationError);
  });

  test('keeps the planted defect: the seeded Prestige customer has no sign-in policy', () => {
    const { signIn, SignInPolicyError } = loadSignInRules();
    let error;
    try { signIn('48213907', 'Demo2026!', 'web'); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(SignInPolicyError);
    expect(error.message).toBe('No sign-in policy for segment MILLENNIUM_PRESTIGE (Millekod 4821****, channel web)');
    expect(error.code).toBe(ERROR_CODE);
  });
});

describe('Bank Millennium login failure report bridge', () => {
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
    expect(isAppReport({ ...WEB_REPORT, source: 'bank-millennium/ios' })).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'bank-millennium/windows' })).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'bank-millennium/android' })).toBe(false);
    expect(isAppReport({ ...WEB_REPORT, service: 'customer-piba-passport' })).toBe(false);
  });

  test('rejects reports with the wrong identity', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'piba-passport/web' });
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
      customer: 'bf98154e',
      sessionPlatform: 'linux',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
      skipVulnerablePr: true,
      title: `[Bank Millennium] ${ERROR_CODE} login failed for segment MILLENNIUM_PRESTIGE (web)`,
    });
    expect(alertData.extra).toMatchObject({ segment: 'MILLENNIUM_PRESTIGE', millekodMasked: '4821****', platform: 'web' });
    expect(isInstantPathEvent(alertData)).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('labels Windows reports as Windows', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'bank-millennium/windows', platform: 'windows' });
    expect(status).toBe(202);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(createSessionAndAlert.mock.calls[0][0].verticalLabel).toBe('Bank Millennium — Millenet login (Windows)');
  });

  test('the orchestrator prompt routes each platform to the right VM and folder', () => {
    expect(BANK_MILLENNIUM_SESSION_PLATFORM).toBe('linux');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*macOS\* child for `COG-GTM\/event-driven-ios`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Windows\* child for `COG-GTM\/event-driven-devin` \(`windows\/BankMillennium\/` only\)/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Linux\* child for `COG-GTM\/event-driven-devin`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/create THREE child/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('?reports=off');
    const directive = APP_REMEDIATION_DIRECTIVE;
    expect(directive.indexOf('Devin session link')).toBeLessThan(directive.indexOf('1. Diagnose'));
    expect(directive).toMatch(/new incident even if the same error has alerted before/);
    expect(directive).not.toMatch(/planted|replica/);
  });
});
