/* global describe, expect, test, jest, beforeEach, beforeAll, afterAll */
jest.mock('../app/services/slack', () => ({
  postMessage: jest.fn(() => Promise.resolve('1730000000.000100')),
  joinChannel: jest.fn(() => Promise.resolve()),
  buildAlertBlocks: jest.fn(() => [{ type: 'header', text: { type: 'plain_text', text: 'alert' } }]),
  buildAlertText: jest.fn((alertData) => `:rotating_light: ${alertData.issueTitle}`),
  resolveOnCallMember: jest.fn(() => Promise.resolve()),
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
const fs = require('fs');
const http = require('http');
const path = require('path');
const { postMessage, joinChannel, buildAlertBlocks } = require('../app/services/slack');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const { Sentry } = require('../app/telemetry/sentry');
const service = require('../app/services/verticals/954aa69c');
const router = require('../app/routes/verticals/954aa69c');
const { getCustomerConfig, listAliases } = require('../config/customers');

const { CUSTOMER, API_BASE, ROUTE, ROUTE_ERROR, ONCALL_CHANNEL, RESPONDER_NOTES } = service;
const LEAK_PATTERN = /\.js|FIX_SESSIONS|FIX50SP2|senderCompId|openBrokerSession|at Object/;

let server;
let baseUrl;

function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}${urlPath}`, { method, headers: { 'content-type': 'application/json' } }, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data), raw: data, headers: res.headers }));
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(() => {
  jest.clearAllMocks();
  service.resetBlotter();
  service.resetIncidentWindow();
  process.env.SLACK_BOT_TOKEN = 'xoxb-test';
  delete process.env.SLACK_ONCALL_BOT_TOKEN;
});

describe('Bloomberg Terminal vertical wiring', () => {
  test('customer config pages #bloomberg-oncall and exposes the aliases', () => {
    expect(getCustomerConfig(CUSTOMER)).toMatchObject({
      customer: CUSTOMER, triggerMode: 'api', slackChannelId: 'C0CKXTAMWQY',
    });
    expect(ONCALL_CHANNEL).toEqual({ id: 'C0CKXTAMWQY', name: '#bloomberg-oncall' });
    const aliases = listAliases();
    ['bloomberg-terminal', 'bbg-terminal', 'emsx'].forEach((alias) => expect(aliases[alias]).toBe(CUSTOMER));
    expect(aliases.bloomberg).toBe('bd631c20');
  });

  test('page ships the terminal functions and calls the vertical API', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', `${CUSTOMER}.html`), 'utf8');
    ['pane-EMSX', 'pane-WEI', 'pane-TOP', 'pane-DES', 'pane-GP', 'act-route', 'id="cmd"'].forEach((marker) => expect(html).toContain(marker));
    expect(html).toContain(`'${API_BASE}'`);
    expect(html).not.toMatch(/FIX50SP2|senderCompId/);
  });
});

describe('EMSX blotter and staging', () => {
  test('GET /blotter returns the seeded staged orders', async () => {
    const res = await request('GET', `${API_BASE}/blotter`);
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.body.orders).toHaveLength(6);
    expect(res.body.orders.every((order) => order.status === 'STAGED')).toBe(true);
    expect(res.body.summary).toMatchObject({ staged: 6, routed: 0 });
    expect(res.body.summary.stagedNotional).toBeGreaterThan(200_000_000);
    expect(res.body.brokers.map((broker) => broker.code)).toEqual(['MSCO', 'GSCO', 'JPMS', 'CITI']);
  });

  test('POST /orders stages a valid order', async () => {
    const res = await request('POST', `${API_BASE}/orders`, {
      ticker: 'IBM US', side: 'BUY', quantity: 1000, orderType: 'LMT', limitPrice: 214.5, tif: 'DAY', broker: 'MSCO', strategy: 'VWAP',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ ticker: 'IBM US', status: 'STAGED', notional: 214500 });
    expect((await request('GET', `${API_BASE}/blotter`)).body.orders).toHaveLength(7);
  });

  test.each([
    [{ ticker: 'ZZZZ US', side: 'BUY', quantity: 1, broker: 'MSCO', strategy: 'VWAP' }, 'UNKNOWN_SECURITY'],
    [{ ticker: 'IBM US', side: 'HOLD', quantity: 1, broker: 'MSCO', strategy: 'VWAP' }, 'INVALID_SIDE'],
    [{ ticker: 'IBM US', side: 'BUY', quantity: 0, broker: 'MSCO', strategy: 'VWAP' }, 'INVALID_QUANTITY'],
    [{ ticker: 'IBM US', side: 'BUY', quantity: 1, orderType: 'LMT', broker: 'MSCO', strategy: 'VWAP' }, 'INVALID_LIMIT'],
    [{ ticker: 'IBM US', side: 'BUY', quantity: 1, broker: 'XXXX', strategy: 'VWAP' }, 'UNKNOWN_BROKER'],
    [{ ticker: 'IBM US', side: 'BUY', quantity: 1, broker: 'MSCO', strategy: 'SONAR' }, 'UNKNOWN_STRATEGY'],
  ])('POST /orders rejects %j', async (body, code) => {
    const res = await request('POST', `${API_BASE}/orders`, body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(postMessage).not.toHaveBeenCalled();
  });
});

describe('EMSX routing incident', () => {
  test('routing a staged order returns a sanitized 503 and keeps it staged', async () => {
    const res = await request('POST', ROUTE, { orderId: 'EMSX-4718201' });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ success: false, error: ROUTE_ERROR, code: 'ROUTE_UNAVAILABLE' });
    expect(res.body.requestId).toMatch(/^EMR-[0-9A-F]{8}$/);
    expect(res.raw).not.toMatch(LEAK_PATTERN);
    const { orders } = (await request('GET', `${API_BASE}/blotter`)).body;
    expect(orders.find((order) => order.orderId === 'EMSX-4718201').status).toBe('STAGED');
  });

  test('first failure posts one alert-only card to #bloomberg-oncall', async () => {
    const error = await service.routeOrder({ orderId: 'EMSX-4718202' }, { hold: 0 }).catch((e) => e);
    expect(error.name).toBe('TypeError');
    await error.alertPromise;

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({ route: ROUTE, alert_path: 'instant', broker: 'GSCO' });
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [token, channel, text, blocks] = postMessage.mock.calls[0];
    expect(token).toBe('xoxb-test');
    expect(channel).toBe(ONCALL_CHANNEL.id);
    expect(text).toContain(RESPONDER_NOTES);
    expect(blocks[blocks.length - 1].elements[0].text).toBe(RESPONDER_NOTES);

    const [alert, options] = buildAlertBlocks.mock.calls[0];
    expect(options).toEqual({ includeDevinOnCall: false });
    expect(alert.extra).toMatchObject({ orderId: 'EMSX-4718202', stagedOrdersUnrouted: 6 });
    expect(alert.extra.stagedNotionalUsd).toBeGreaterThan(200_000_000);
    expect(isInstantPathEvent({ issueTitle: alert.issueTitle, culprit: alert.culprit, tags: [] })).toBe(true);
  });

  test('later failures inside the window join the open incident', async () => {
    const first = await service.routeOrder({ orderId: 'EMSX-4718201' }, { hold: 0 }).catch((e) => e);
    await first.alertPromise;
    const second = await service.routeOrder({ orderId: 'EMSX-4718203' }, { hold: 0 }).catch((e) => e);
    await second.alertPromise;
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  test('joins the channel and retries when the bot is not a member', async () => {
    postMessage.mockRejectedValueOnce(new Error('Slack API error: not_in_channel'));
    const error = await service.routeOrder({ orderId: 'EMSX-4718201' }, { hold: 0 }).catch((e) => e);
    await expect(error.alertPromise).resolves.toMatchObject({ ok: true, channel: ONCALL_CHANNEL.id });
    expect(joinChannel).toHaveBeenCalledWith('xoxb-test', ONCALL_CHANNEL.id);
    expect(postMessage).toHaveBeenCalledTimes(2);
  });

  test('without a Slack token nothing is posted and the window reopens', async () => {
    delete process.env.SLACK_BOT_TOKEN;
    const error = await service.routeOrder({ orderId: 'EMSX-4718201' }, { hold: 0 }).catch((e) => e);
    await expect(error.alertPromise).resolves.toBeNull();
    expect(postMessage).not.toHaveBeenCalled();
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    const again = await service.routeOrder({ orderId: 'EMSX-4718201' }, { hold: 0 }).catch((e) => e);
    await again.alertPromise;
    expect(postMessage).toHaveBeenCalledTimes(1);
  });

  test('unknown order is a 400 and raises no alert', async () => {
    const res = await request('POST', ROUTE, { orderId: 'EMSX-1' });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_ORDER');
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
