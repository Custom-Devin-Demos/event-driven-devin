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
  PIBA_PASSPORT_SESSION_PLATFORM,
  APP_REMEDIATION_DIRECTIVE,
  APP_SERVICE,
  ERROR_CODE,
  REPORT_PATH,
  isAppReport,
} = require('../app/services/verticals/piba-passport');
const router = require('../app/routes/verticals/piba-passport');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const customer = require('../config/customers/b09e76ca');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', 'b09e76ca.html'), 'utf8');

const WEB_REPORT = {
  source: 'piba-passport/web',
  service: APP_SERVICE,
  platform: 'web',
  screen: 'Payment',
  action: 'payAndConfirm',
  errorType: 'FeeScheduleError.serviceNotInSchedule',
  errorMessage: 'No fee schedule entry for service PASSPORT_BIOMETRIC_RENEWAL (fee schedule 2026-01-01, adult, online-winter)',
  errorCode: 'PIBA-FEE-4221',
  serviceCode: 'PASSPORT_BIOMETRIC_RENEWAL',
  documentType: 'passport',
  requestReason: 'renewal',
  ageBand: 'adult',
  feeRate: 'online-winter',
  feeSchedule: '2026-01-01',
  branch: 'tlv',
  appointment: '2026-11-12T09:40',
  appVersion: '2026.1.4',
  devinUserId: '',
  devinEmail: '',
  devinOrgId: '',
};

/** Evaluates the page's fee rules (no DOM) so the planted defect is tested as code. */
function loadFeeRules() {
  const rules = PAGE.slice(PAGE.indexOf('/* FEE_RULES:start'), PAGE.indexOf('/* FEE_RULES:end */'));
  const sandbox = {};
  vm.runInNewContext(`${rules}\nthis.buildPaymentOrder = buildPaymentOrder; this.publicFee = publicFee; this.FeeScheduleError = FeeScheduleError;`, sandbox);
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

const WINTER = new Date(2026, 10, 12);
const SUMMER = new Date(2026, 6, 1);

describe('gov.il biometric passport replica (/passport)', () => {
  test('is reachable at the friendly aliases', () => {
    expect(customer.aliases).toEqual(expect.arrayContaining(['passport', 'piba']));
  });

  test('is a Hebrew RTL page', () => {
    expect(PAGE).toContain('<html lang="he" dir="rtl">');
    expect(PAGE).toContain('לתשלום ואישור התור');
  });

  test('reports with the PIBA passport client identity and supports ?reports=off', () => {
    expect(PAGE).toContain("var REPORT_PATH = '/api/piba/passport/error';");
    expect(PAGE).toContain("source: 'piba-passport/web'");
    expect(PAGE).toContain("service: 'customer-piba-passport'");
    expect(PAGE).toContain("get('reports') !== 'off'");
    expect(PAGE).not.toMatch(/@cognition\.ai|org_[A-Za-z0-9]{8,}/);
  });

  test('shows a red error banner and modal when payment fails', () => {
    expect(PAGE).toMatch(/--red: #c8102e/);
    expect(PAGE).toContain('id="pay-error"');
    expect(PAGE).toContain('id="error-modal"');
    expect(PAGE).toContain('לא ניתן להשלים את התשלום');
  });

  test('shows the published online fee (185 winter, 290 summer) for an adult renewal', () => {
    const { publicFee } = loadFeeRules();
    expect(publicFee('renewal', 'adult', WINTER)).toBe(185);
    expect(publicFee('renewal', 'adult', SUMMER)).toBe(290);
  });

  test('is clearly labelled as a mock website', () => {
    expect(PAGE).toMatch(/<title>\[MOCK/);
    expect(PAGE).toContain('MOCK WEBSITE');
    expect(PAGE).toContain('class="mock-badge"');
    expect(PAGE).toContain('תשלום מדומה');
  });

  test('keeps the planted defect: a passport renewal has no 2026 fee schedule entry', () => {
    const { buildPaymentOrder } = loadFeeRules();
    expect(() => buildPaymentOrder({ documentType: 'passport', reason: 'renewal', ageBand: 'adult' }, WINTER))
      .toThrow(/No fee schedule entry for service PASSPORT_BIOMETRIC_RENEWAL/);
    expect(buildPaymentOrder({ documentType: 'passport', reason: 'first', ageBand: 'adult' }, WINTER))
      .toMatchObject({ serviceCode: 'PASSPORT_FIRST', amount: 185, feeRate: 'online-winter' });
    expect(buildPaymentOrder({ documentType: 'passport', reason: 'lost', ageBand: 'minor' }, SUMMER))
      .toMatchObject({ serviceCode: 'PASSPORT_LOST', amount: 310, feeRate: 'online-summer' });
  });
});

describe('PIBA passport failure report bridge', () => {
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
    expect(isAppReport({ ...WEB_REPORT, source: 'piba-passport/ios' })).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'piba-passport/windows' })).toBe(true);
    expect(isAppReport({ ...WEB_REPORT, source: 'piba-passport/android' })).toBe(false);
    expect(isAppReport({ ...WEB_REPORT, service: 'customer-amdocs-nwm' })).toBe(false);
  });

  test('rejects reports with the wrong identity', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'amdocs-nwm/web' });
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
      customer: 'b09e76ca',
      sessionPlatform: 'linux',
      promptAppendix: APP_REMEDIATION_DIRECTIVE,
      skipVulnerablePr: true,
      title: `[gov.il Passport] ${ERROR_CODE} fee payment failed for PASSPORT_BIOMETRIC_RENEWAL (web)`,
    });
    expect(alertData.extra).toMatchObject({ serviceCode: 'PASSPORT_BIOMETRIC_RENEWAL', requestReason: 'renewal', platform: 'web' });
    expect(isInstantPathEvent(alertData)).toBe(true);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test('labels Windows reports as Windows', async () => {
    const { status } = await postJson(server, { ...WEB_REPORT, source: 'piba-passport/windows', platform: 'windows' });
    expect(status).toBe(202);
    await new Promise((resolve) => { setImmediate(resolve); });
    expect(createSessionAndAlert.mock.calls[0][0].verticalLabel).toBe('gov.il Biometric passport — Fee payment (Windows)');
  });

  test('the orchestrator prompt routes each platform to the right VM and folder', () => {
    expect(PIBA_PASSPORT_SESSION_PLATFORM).toBe('linux');
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*macOS\* child for `COG-GTM\/event-driven-ios`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Windows\* child for `COG-GTM\/event-driven-devin` \(`windows\/PibaPassport\/` only\)/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/\*Linux\* child for `COG-GTM\/event-driven-devin`/);
    expect(APP_REMEDIATION_DIRECTIVE).toMatch(/create THREE child/);
    expect(APP_REMEDIATION_DIRECTIVE).toContain('?reports=off');
    expect(APP_REMEDIATION_DIRECTIVE).not.toContain('DO NOT MERGE');
  });
});
