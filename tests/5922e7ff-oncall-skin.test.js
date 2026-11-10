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

const SLUG = '5922e7ff';
const ORDERS = '/api/oncall/wealthorders/orders';
const REBALANCE = '/api/oncall/wealthrebalance/submit';
const ORDER = {
  accountId: 'HRP-TR-0158', symbol: 'MSFT', side: 'buy', quantity: 100, orderType: 'limit', limitPrice: 430, timeInForce: 'day',
};
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
  createDevinSession.mockResolvedValue({ sessionId: 'wm-order-session', url: 'https://app.devin.ai/sessions/wm-order-session' });
  declareDatadogIncident.mockReset().mockResolvedValue({ id: 'incident-test', publicId: 412 });
});

function freshRebalanceService() {
  let service;
  jest.isolateModules(() => { service = require('../app/services/oncall-verticals/wealthrebalance'); });
  return service;
}

describe('Advisor Desk on-call skin', () => {
  test('serves the shimmed page on the skin, anonymous and friendly URLs', async () => {
    for (const url of [`/oncall/c/${SLUG}`, `/${SLUG}`, '/morgan-stanley', '/morgan-stanley-oncall']) {
      const response = await fetch(baseUrl + url);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<title>Advisor Desk | Morgan Stanley Wealth Management</title>');
      expect(html).toContain('NOT ACTUALLY A MORGAN STANLEY SITE');
      expect(html).toContain('const oncallApiPath = "/api/oncall/wealthorders/orders"');
      expect(html).toContain('const alertOnStatus = [500]');
      expect(html).toContain('var skinAlertDestination = "slack"');
      expect(html).toContain('Rebalance households');
      expect(html).not.toContain('← All Demos');
      for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) {
        expect(() => new vm.Script(script[1])).not.toThrow();
      }
    }
  });

  test('keeps the page free of mockup furniture, logos and personal data', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/5922e7ff.html'), 'utf8');
    expect(html).toContain("var ORDER_ENDPOINT = '/api/5922e7ff/orders'");
    expect(html).toContain("var REBALANCE_ENDPOINT = '/api/oncall/wealthrebalance/submit'");
    expect(html).not.toMatch(/<svg|<img|Cognition|demo replica|planted|humza|cognition\.ai|FDC3/i);
  });

  test('initially hidden panels with their own display rule also hide via [hidden]', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/5922e7ff.html'), 'utf8');
    const hiddenClasses = [...html.matchAll(/<[a-z]+[^>]*class="([^"]+)"[^>]*\shidden[\s>]/g)]
      .flatMap((m) => m[1].split(/\s+/));
    const displayed = hiddenClasses.filter((c) => new RegExp(`\\.${c}\\s*\\{[^}]*display:`).test(html));
    expect(displayed).toContain('outage');
    for (const c of displayed) expect(html).toMatch(new RegExp(`\\.${c}\\[hidden\\]\\s*\\{\\s*display:\\s*none`));
  });

  test('order routing alert immediately starts an investigation and replies with its session link, without declaring an incident', async () => {
    const skin = getOncallSkin(SLUG);
    expect(skin.datadogIncident).toBeUndefined();
    const response = await postOncallAlert('wealthorders', { skin, runRef: 'wm-order-test' });
    expect(response.ok).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const card = postMessage.mock.calls[0][2];
    expect(card).toContain('wm-order-routing-api');
    expect(card).toContain('POST /api/oncall/wealthorders/orders');
    expect(card).not.toMatch(/Regions|State Street|TypeError|app\/services/);
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(createDevinSession.mock.calls[0][0]).toContain('wm-order-routing-api');
    expect(postThreadReply).toHaveBeenCalledWith('xoxb-test', 'C0TEST', '1700000000.000100',
      expect.stringContaining(response.sessionUrl), expect.any(Array));
  });

  test('every valid equity or ETF order fails in venue selection with a 500', async () => {
    for (const body of [ORDER, { ...ORDER, symbol: 'vti', side: 'sell', orderType: 'market', quantity: 25, accountId: 'CHF-EN-0905' }]) {
      const response = await post(ORDERS, body);
      expect(response.status).toBe(500);
      const data = await response.json();
      expect(data).toMatchObject({ success: false, code: 'ORDER_ROUTING_FAILED', errorClass: 'TypeError' });
      expect(data.error).toBe('The order could not be routed.');
    }
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException.mock.calls[0][0].message).toMatch(/reading 'maxClipShares'/);
    expect(incrementMetric).toHaveBeenCalledWith('wm.order_routing.failure', expect.objectContaining({ service: 'wm-order-routing-api' }));
    expect(postMessage).not.toHaveBeenCalled();
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });

  test.each([
    {}, { ...ORDER, accountId: 'constructor' }, { ...ORDER, symbol: 'ZZZZ' }, { ...ORDER, side: 'short' },
    { ...ORDER, quantity: 0 }, { ...ORDER, quantity: 1.5 }, { ...ORDER, limitPrice: -1 },
  ])('invalid order %j is rejected with a 400 before routing', async (body) => {
    const response = await post(ORDERS, body);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_ORDER');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('rejects unknown rebalances without incidents or failure telemetry', async () => {
    const response = await post(REBALANCE, { batchId: 'unknown' });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('INVALID_REBALANCE');
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(incrementMetric).not.toHaveBeenCalled();
  });

  test('rebalance returns a real 503, records outage telemetry and declares only a SEV-1 incident', async () => {
    const response = await post(REBALANCE, { batchId: 'RB-GRW7030-1110', devinEmail: 'operator@example.com' });
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data.code).toBe('REBALANCE_UNAVAILABLE');
    expect(data.batch).toMatchObject({ households: 3, tradeCount: 42, notionalUsd: 4860000 });
    expect(data.incident).toMatchObject({ status: 'declared', publicId: 412 });
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({
      severity: 'SEV-1', service: 'wm-rebalance-engine', triggeredBy: 'operator@example.com',
      title: 'Morgan Stanley: Advisor Desk model rebalance outage',
    }));
    expect(incrementMetric).toHaveBeenCalledWith('wm.rebalance.failure', expect.objectContaining({ service: 'wm-rebalance-engine' }));
    expect(Sentry.captureException.mock.calls[0][0].message).toMatch(/reading 'dispatch'/);
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(queueIncidentChannelInvites).toHaveBeenCalledWith({ publicId: 412, userIds: ['U0BQZBHCNMA'] });
  });

  test('valid rebalances have their own hourly limit, invalid ones consume none', async () => {
    const headers = { 'X-Forwarded-For': '192.0.2.77' };
    for (let count = 0; count < 55; count++) expect((await post(REBALANCE, { batchId: 'nope' }, headers)).status).toBe(400);
    for (let count = 0; count < 50; count++) expect((await post(REBALANCE, { batchId: 'RB-GRW7030-1110' }, headers)).status).toBe(503);
    const capped = await post(REBALANCE, { batchId: 'RB-GRW7030-1110' }, headers);
    expect(capped.status).toBe(429);
    expect(Number(capped.headers.get('Retry-After'))).toBeGreaterThan(0);
  });
});

describe('Advisor Desk rebalance incident lifecycle', () => {
  test('deduplicates concurrent and repeated rebalances for five minutes', async () => {
    const { submitRebalance } = freshRebalanceService();
    const submit = () => submitRebalance({ batchId: 'RB-GRW7030-1110' });
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
    const { submitRebalance } = freshRebalanceService();
    declareDatadogIncident.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Datadog 403'));
    expect((await submitRebalance({ batchId: 'RB-GRW7030-1110' })).body.incident.status).toBe('unavailable');
    const failed = await submitRebalance({ batchId: 'RB-GRW7030-1110', devinEmail: { unsafe: true } });
    expect(failed.statusCode).toBe(503);
    expect(failed.body.incident.status).toBe('failed');
    expect(declareDatadogIncident).toHaveBeenLastCalledWith(expect.objectContaining({ triggeredBy: 'oncall/c/5922e7ff' }));
    expect((await submitRebalance({ batchId: 'RB-GRW7030-1110' })).body.incident.status).toBe('declared');
  });
});
