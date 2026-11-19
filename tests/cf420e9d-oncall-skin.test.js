/* global afterAll, beforeAll, beforeEach, describe, expect, jest, test, fetch */
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() }, initSentry: jest.fn() }));
jest.mock('../app/telemetry/datadog', () => ({ tracer: { trace: jest.fn((_name, _options, fn) => fn()) }, incrementMetric: jest.fn(), recordTiming: jest.fn() }));
jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/services/devin-api', () => ({ createDevinSession: jest.fn() }));
jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));
jest.mock('../app/services/datadog-incidents', () => ({ declareDatadogIncident: jest.fn() }));
jest.mock('../app/services/datadog-incident-slack', () => ({ queueIncidentChannelInvites: jest.fn() }));

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { queueIncidentChannelInvites } = require('../app/services/datadog-incident-slack');
const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { incrementMetric } = require('../app/telemetry/datadog');
const { Sentry } = require('../app/telemetry/sentry');
const { getOncallSkin } = require('../config/oncall-skins');
const { postOncallAlert, resetSkinAlertMemory } = require('../app/services/oncall');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

const SLUG = 'cf420e9d';
const PLAN_CHANGES = '/api/oncall/internetupgrades/orders';
const PAYMENTS = '/api/oncall/billpayments/submit';
const CHANGE = { accountNumber: '8495-1120-0418', offerId: 'XF-INT-GIGX', effective: 'now', termsAccepted: true };
const PAYMENT = { billId: 'XF-BILL-1202', methodId: 'pm-visa-4421', amount: 184.97 };
const PAGE = path.join(__dirname, '../app/public/verticals/cf420e9d.html');
let server;
let baseUrl;

const post = (url, body, headers = {}) => fetch(baseUrl + url, {
  method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
});

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(require('../app/routes/oncall'));
  app.use(require('../app/routes/oncall-verticals'));
  server = http.createServer(app).listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await stopGateway();
});

beforeEach(() => {
  jest.clearAllMocks();
  resetSkinAlertMemory();
  createDevinSession.mockResolvedValue({ sessionId: 'xf-plan-session', url: 'https://app.devin.ai/sessions/xf-plan-session' });
  declareDatadogIncident.mockReset().mockResolvedValue({ id: 'incident-test', publicId: 518 });
});

function freshPaymentService() {
  let service;
  jest.isolateModules(() => { service = require('../app/services/oncall-verticals/billpayments'); });
  return service;
}

describe('Xfinity My Account on-call skin', () => {
  test('serves the shimmed page on the skin, anonymous and friendly URLs', async () => {
    for (const url of [`/oncall/c/${SLUG}`, `/${SLUG}`, '/xfinity', '/xfinity-oncall']) {
      const response = await fetch(baseUrl + url);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<title>My Account | Xfinity</title>');
      expect(html).toContain('NOT ACTUALLY AN XFINITY SITE');
      expect(html).toContain('const oncallApiPath = "/api/oncall/internetupgrades/orders"');
      expect(html).toContain('const alertOnStatus = [500]');
      expect(html).toContain('var skinAlertDestination = "slack"');
      expect(html).toContain('Make a payment');
      expect(html).toContain('body:has(#toast:not([hidden])) #oncall-ribbon');
      expect(html).not.toContain('← All Demos');
      for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        expect(() => new vm.Script(script[1])).not.toThrow();
      }
    }
  });

  test('keeps the page free of mockup furniture, logos and personal data', () => {
    const html = fs.readFileSync(PAGE, 'utf8');
    expect(html).toContain("var UPGRADE_ENDPOINT = '/api/cf420e9d/plan-changes'");
    expect(html).toContain("var PAY_ENDPOINT = '/api/oncall/billpayments/submit'");
    expect(html).not.toMatch(/<svg|<img|Cognition|demo replica|planted|cognition\.ai/i);
  });

  test('outage banner starts hidden and only appears after a payment outage', () => {
    const html = fs.readFileSync(PAGE, 'utf8');
    expect(html).toMatch(/<div class="outage" id="outage-banner" hidden/);
    expect(html).toMatch(/\.outage\[hidden\]\s*\{\s*display:\s*none/);
    expect(html).toContain("renderScheduled('scheduled');");
    expect(html).toMatch(/PAYMENTS_UNAVAILABLE[\s\S]*outage-banner'\)\.hidden = false[\s\S]*renderScheduled\('blocked'\)/);
  });

  test('skin auto-starts a Devin investigation in this repo', () => {
    const skin = getOncallSkin(SLUG);
    expect(skin.devinSession.auto).toBe(true);
    expect(skin.devinSession.onCallIsTriggerer).toBe(true);
    expect(skin.devinSession.repo).toBeUndefined();
    expect(skin.onCallSlackMemberId).toBe('U0BLF6TLGP4');
    expect(skin.devinSession.promptAppendix).toMatch(/do not merge or deploy/);
  });

  test('plan change alert immediately starts an investigation and replies with its session link, without declaring an incident', async () => {
    const skin = getOncallSkin(SLUG);
    expect(skin.datadogIncident).toBeUndefined();
    const response = await postOncallAlert('internetupgrades', { skin, runRef: 'xf-plan-test' });
    expect(response.ok).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const card = postMessage.mock.calls[0][2];
    expect(card).toContain('broadband-plan-change-api');
    expect(card).toContain('POST /api/oncall/internetupgrades/orders');
    expect(card).not.toMatch(/Morgan Stanley|TypeError|app\/services/);
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(createDevinSession.mock.calls[0][0]).toContain('broadband-plan-change-api');
    expect(createDevinSession.mock.calls[0][0]).toContain('app/services/oncall-verticals/internetupgrades.js');
    expect(postThreadReply).toHaveBeenCalledWith('xoxb-test', 'C0TEST', '1700000000.000100',
      expect.stringContaining(response.sessionUrl), expect.any(Array));
  });

  test('every valid plan change fails in modem provisioning with a 500', async () => {
    const bodies = [CHANGE, { ...CHANGE, offerId: 'XF-INT-GIGX2', effective: 'next_bill' },
      { ...CHANGE, accountNumber: '8495-1120-0733', offerId: 'XF-INT-GIG' }];
    for (const body of bodies) {
      const response = await post(PLAN_CHANGES, body);
      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data).toMatchObject({ success: false, code: 'PLAN_CHANGE_FAILED', errorClass: 'TypeError' });
    }
    expect(Sentry.captureException).toHaveBeenCalledTimes(bodies.length);
    expect(Sentry.captureException.mock.calls[0][0].message).toMatch(/reading 'bootFile'/);
    expect(incrementMetric).toHaveBeenCalledWith('broadband.plan_change.failure', expect.objectContaining({ service: 'broadband-plan-change-api' }));
    expect(postMessage).not.toHaveBeenCalled();
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });

  test.each([
    {}, { ...CHANGE, accountNumber: 'constructor' }, { ...CHANGE, offerId: 'XF-INT-10G' }, { ...CHANGE, offerId: 'XF-INT-GIG' },
    { ...CHANGE, effective: 'yesterday' }, { ...CHANGE, termsAccepted: false },
  ])('invalid plan change %j is rejected with a 400 before provisioning', async (body) => {
    const response = await post(PLAN_CHANGES, body);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_PLAN_CHANGE');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each([
    { billId: 'unknown' }, { ...PAYMENT, methodId: 'constructor' }, { ...PAYMENT, amount: 0.5 }, { ...PAYMENT, amount: 500 },
  ])('invalid payment %j is rejected without incidents or failure telemetry', async (body) => {
    const response = await post(PAYMENTS, body);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_PAYMENT');
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(incrementMetric).not.toHaveBeenCalled();
  });

  test('payment returns a real 503, records outage telemetry and declares only a SEV-1 incident', async () => {
    const response = await post(PAYMENTS, { ...PAYMENT, devinEmail: 'operator@example.com' });
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.code).toBe('PAYMENTS_UNAVAILABLE');
    expect(data.bill).toMatchObject({ id: 'XF-BILL-1202', balance: 184.97 });
    expect(data.incident).toMatchObject({ status: 'declared', publicId: 518, channelPrefix: 'sev-1-incident' });
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'SEV-1', service: 'billpay-payments-gateway', triggeredBy: 'operator@example.com',
      title: 'Xfinity: My Account bill payment outage', repoUrl: 'https://github.com/COG-GTM/event-driven-devin',
    }));
    expect(declareDatadogIncident.mock.calls[0][0].severity).not.toBe('SEV-2');
    expect(incrementMetric).toHaveBeenCalledWith('billpay.payment.failure', expect.objectContaining({ service: 'billpay-payments-gateway' }));
    expect(Sentry.captureException.mock.calls[0][0].message).toMatch(/reading 'authorize'/);
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(queueIncidentChannelInvites).toHaveBeenCalledWith({ publicId: 518, userIds: ['U0BLF6TLGP4'] });
  });

  test('valid payments have their own hourly limit, invalid ones consume none', async () => {
    const headers = { 'X-Forwarded-For': '192.0.2.81' };
    for (let count = 0; count < 55; count++) expect((await post(PAYMENTS, { billId: 'nope' }, headers)).status).toBe(400);
    for (let count = 0; count < 50; count++) expect((await post(PAYMENTS, PAYMENT, headers)).status).toBe(503);
    const capped = await post(PAYMENTS, PAYMENT, headers);
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});

describe('Xfinity bill payment incident lifecycle', () => {
  test('deduplicates concurrent and repeated payments for five minutes', async () => {
    const { submitPayment } = freshPaymentService();
    const submit = () => submitPayment(PAYMENT);
    const results = await Promise.all([submit(), submit(), submit()]);
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.body.incident.runRef)).size).toBe(1);
    expect((await submit()).body.incident.reused).toBe(true);
    const now = Date.now();
    const clock = jest.spyOn(Date, 'now').mockReturnValue(now + 5 * 60000 + 1);
    try { await submit(); } finally { clock.mockRestore(); }
    expect(declareDatadogIncident).toHaveBeenCalledTimes(2);
  });

  test('keeps the outage visible when declaration is unavailable or fails, and allows a retry', async () => {
    const { submitPayment } = freshPaymentService();
    declareDatadogIncident.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Datadog 403'));
    expect((await submitPayment(PAYMENT)).body.incident.status).toBe('unavailable');
    const failed = await submitPayment({ ...PAYMENT, devinEmail: { unsafe: true } });
    expect(failed.statusCode).toBe(503);
    expect(failed.body.incident.status).toBe('failed');
    expect(declareDatadogIncident).toHaveBeenLastCalledWith(expect.objectContaining({ triggeredBy: 'oncall/c/cf420e9d' }));
    expect((await submitPayment(PAYMENT)).body.incident.status).toBe('declared');
  });
});
