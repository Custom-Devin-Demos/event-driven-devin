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

const SLUG = '5abd65f5';
const TRANSFER = '/api/oncall/cibc/transfers';
const SEND = '/api/oncall/cibc/etransfer/send';
const PAYMENT = { batchId: 'ET-CAD-2048' };
const VALID = { fromAccount: 'CHQ-4826', toAccount: 'SAV-7391', amount: 200 };
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
  createDevinSession.mockResolvedValue({ sessionId: 'cibc-transfer', url: 'https://app.devin.ai/sessions/cibc-transfer' });
  declareDatadogIncident.mockReset().mockResolvedValue({ id: 'incident-test', publicId: 412 });
});
function freshService() {
  let service;
  jest.isolateModules(() => { service = require('../app/services/oncall-verticals/cibc-etransfer'); });
  return service;
}
describe('CIBC My Accounts on-call skin', () => {
  test('aliases resolve to the native page with Quick Transfer shim and both main-page cards', async () => {
    for (const url of [`/oncall/c/${SLUG}`, `/${SLUG}`, '/cibc', '/cibc-oncall']) {
      const response = await fetch(baseUrl + url);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<title>My Accounts | CIBC Online Banking</title>');
      expect(html).toContain('NOT ACTUALLY A CIBC SITE');
      expect(html.match(/NOT ACTUALLY A CIBC SITE/g)).toHaveLength(1);
      const brandingScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]
        .find((script) => script[1].includes('var disclaimer ='))[1];
      const firstChild = {};
      const document = {
        querySelector: () => null,
        createElement: () => ({ style: {} }),
        body: { firstChild, insertBefore: jest.fn() },
      };
      vm.runInNewContext(brandingScript, { document });
      expect(document.body.insertBefore).toHaveBeenCalledWith(
        expect.objectContaining({ textContent: getOncallSkin(SLUG).disclaimer }), firstChild,
      );
      expect(html).toContain('const oncallApiPath = "/api/oncall/cibc/transfers"');
      expect(html).toContain('const alertOnStatus = [500]');
      expect(html).toContain('var skinAlertDestination = "slack"');
      expect(html).toContain('id="quick"');
      expect(html).toContain('id="interac"');
      expect(html).not.toContain('← All Demos');
      for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(script[1])).not.toThrow();
    }
  });
  test('initially hides outage, reviews and toast and uses fictional CAD accounts', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/5abd65f5.html'), 'utf8');
    expect(html).toMatch(/id="outage"[^>]*hidden/);
    expect(html).toMatch(/id="transferReview"[^>]*hidden/);
    expect(html).toMatch(/id="sendReview"[^>]*hidden/);
    expect(html).toMatch(/id="toast"[^>]*hidden/);
    expect(html).toContain('>Ready</span>');
    expect(html).toContain('>Scheduled</span>');
    expect(html).toContain('CAD');
    expect(html).not.toMatch(/John Doe|199,949\.15|100,000\.00|13,152,223\.38|66,235\.90|188,949\.15|188,649\.15|25,000\.00|00002-54-07583|October 1, 2018/);
  });
  test('normal alert auto-starts a scoped session without declaring an incident', async () => {
    const skin = getOncallSkin(SLUG);
    expect(skin.devinSession.auto).toBe(true);
    expect(skin.devinSession.onCallIsTriggerer).toBe(true);
    expect(skin.onCallSlackMemberId).toBe('U0BQZBHCNMA');
    expect(skin.datadogIncident).toBeUndefined();
    const response = await postOncallAlert('cibctransfers', { skin, runRef: 'cibc-test' });
    expect(response.ok).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][2]).toContain('cibc-account-transfers-api');
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(createDevinSession.mock.calls[0][0]).toContain('cibc-transfers.js');
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(postThreadReply).toHaveBeenCalledWith('xoxb-test', 'C0TEST', '1700000000.000100', expect.stringContaining(response.sessionUrl), expect.any(Array));
  });
  test('valid transfers fail regardless of direction or amount', async () => {
    for (const body of [VALID, { fromAccount: 'SAV-7391', toAccount: 'CHQ-4826', amount: 25.50 }]) {
      const response = await post(TRANSFER, body);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false, code: 'TRANSFER_POSTING_FAILED' });
    }
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException.mock.calls[0][0].message).toContain("reading 'settlementLedger'");
    expect(incrementMetric).toHaveBeenCalledWith('cibc.transfer.failure', expect.objectContaining({ service: 'cibc-account-transfers-api' }));
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });
  test.each([{}, { ...VALID, fromAccount: 'constructor' }, { ...VALID, amount: 0 }, { ...VALID, amount: -1 }, { ...VALID, amount: 999999 }, { ...VALID, toAccount: 'CHQ-4826' }])('rejects invalid transfer %j before posting', async (body) => {
    const response = await post(TRANSFER, body);
    expect(response.status).toBe(400);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
  test('invalid e-Transfers do not declare incidents', async () => {
    for (const body of [{}, { batchId: 'unknown' }]) expect((await post(SEND, body)).status).toBe(400);
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });
  test('e-Transfer returns 503, SEV-1 channel prefix and participant invitation', async () => {
    const response = await post(SEND, { ...PAYMENT, devinEmail: 'operator@example.com' });
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data).toMatchObject({ code: 'ETRANSFER_UNAVAILABLE', incident: { status: 'declared', channelPrefix: 'sev-1-incident' } });
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({ severity: 'SEV-1', service: 'cibc-interac-delivery', triggeredBy: 'operator@example.com' }));
    expect(queueIncidentChannelInvites).toHaveBeenCalledWith({ publicId: 412, userIds: ['U0BQZBHCNMA'] });
    expect(Sentry.captureException.mock.calls[0][0].message).toContain("reading 'send'");
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });
  test('e-Transfer cap rejects the 51st valid request and ignores invalid requests', async () => {
    const headers = { 'X-Forwarded-For': '192.0.2.78' };
    for (let i = 0; i < 51; i++) expect((await post(SEND, {}, headers)).status).toBe(400);
    for (let i = 0; i < 50; i++) expect((await post(SEND, PAYMENT, headers)).status).toBe(503);
    expect((await post(SEND, PAYMENT, headers)).status).toBe(429);
  });
});
describe('CIBC e-Transfer incident lifecycle', () => {
  test('concurrent and repeated sends reuse the incident for five minutes', async () => {
    const { sendMoney } = freshService();
    const results = await Promise.all([sendMoney(PAYMENT), sendMoney(PAYMENT), sendMoney(PAYMENT)]);
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.body.incident.runRef)).size).toBe(1);
    expect((await sendMoney(PAYMENT)).body.incident.reused).toBe(true);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
    try { await sendMoney(PAYMENT); } finally { clock.mockRestore(); }
    expect(declareDatadogIncident).toHaveBeenCalledTimes(2);
  });
  test('declaration failures leave outage visible and allow retry', async () => {
    const { sendMoney } = freshService();
    declareDatadogIncident.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Datadog 403'));
    expect((await sendMoney(PAYMENT)).body.incident.status).toBe('unavailable');
    expect((await sendMoney({ ...PAYMENT, devinEmail: {} })).body.incident.status).toBe('failed');
    expect(declareDatadogIncident).toHaveBeenLastCalledWith(expect.objectContaining({ triggeredBy: 'oncall/c/5abd65f5' }));
    expect((await sendMoney(PAYMENT)).body.incident.status).toBe('declared');
  });
});
