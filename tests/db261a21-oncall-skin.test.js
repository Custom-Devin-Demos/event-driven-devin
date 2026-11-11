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

const SLUG = 'db261a21';
const ORDER = '/api/oncall/walmartorders/orders';
const PICKUP = '/api/oncall/walmartfulfillment/pickup-slots/reserve';
const SLOT = { storeId: 'STORE-4108', slotId: 'today-1700' };
const VALID = { items: [{ itemId: 'WM-58114027', quantity: 1, protectionPlan: null }], fulfillment: 'shipping', zip: '72712' };
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
  createDevinSession.mockResolvedValue({ sessionId: 'walmart-order', url: 'https://app.devin.ai/sessions/walmart-order' });
  declareDatadogIncident.mockReset().mockResolvedValue({ id: 'incident-test', publicId: 518 });
});
function freshService() {
  let service;
  jest.isolateModules(() => { service = require('../app/services/oncall-verticals/walmartfulfillment'); });
  return service;
}
describe('Walmart cart on-call skin', () => {
  test('aliases resolve to the native cart page with the Order now shim', async () => {
    for (const url of [`/oncall/c/${SLUG}`, `/${SLUG}`, '/walmart-2', '/walmart-2-oncall']) {
      const response = await fetch(baseUrl + url);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain('<title>Cart | Walmart.com</title>');
      expect(html.match(/NOT ACTUALLY A WALMART SITE/g)).toHaveLength(1);
      expect(html).toContain('const oncallApiPath = "/api/oncall/walmartorders/orders"');
      expect(html).toContain('const alertOnStatus = [500]');
      expect(html).toContain('var skinAlertDestination = "slack"');
      expect(html).toContain('>Order now</button>');
      expect(html).not.toContain('Continue to checkout');
      expect(html).toContain('id="backToPickup"');
      expect(html).not.toContain('← All Demos');
      for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new vm.Script(script[1])).not.toThrow();
    }
  });
  test('does not take over the existing walmart alias', () => {
    expect(getOncallSkin(SLUG).paths).toEqual(['/walmart-2', '/walmart-2-oncall']);
  });
  test('initially hides outage, checkout, pickup panel and toast', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/db261a21.html'), 'utf8');
    expect(html).toMatch(/id="outage"[^>]*hidden/);
    expect(html).toMatch(/id="checkout"[^>]*hidden/);
    expect(html).toMatch(/id="pickupPanel"[^>]*hidden/);
    expect(html).toMatch(/id="toast"[^>]*hidden/);
    expect(html).toContain('>Available</span>');
    expect(html).not.toContain('>Unavailable</span>');
  });
  test('normal alert auto-starts a scoped session without declaring an incident', async () => {
    const skin = getOncallSkin(SLUG);
    expect(skin.devinSession.auto).toBe(true);
    expect(skin.devinSession.onCallIsTriggerer).toBe(true);
    expect(skin.onCallSlackMemberId).toBe('U0BQZBHCNMA');
    expect(skin.datadogIncident).toBeUndefined();
    const response = await postOncallAlert('walmartorders', { skin, runRef: 'walmart-test' });
    expect(response.ok).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][2]).toContain('walmart-cart-order-api');
    expect(createDevinSession).toHaveBeenCalledTimes(1);
    expect(createDevinSession.mock.calls[0][0]).toContain('walmartorders.js');
    expect(declareDatadogIncident).not.toHaveBeenCalled();
    expect(postThreadReply).toHaveBeenCalledWith('xoxb-test', 'C0TEST', '1700000000.000100', expect.stringContaining(response.sessionUrl), expect.any(Array));
  });
  test('valid orders fail regardless of quantity, plan or fulfillment', async () => {
    const bodies = [VALID, { ...VALID, items: [{ itemId: 'WM-58114027', quantity: 3, protectionPlan: '4yr' }], fulfillment: 'pickup', gift: true }];
    for (const body of bodies) {
      const response = await post(ORDER, body);
      expect(response.status).toBe(500);
      expect(await response.json()).toMatchObject({ success: false, code: 'ORDER_NOT_PLACED' });
    }
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(Sentry.captureException.mock.calls[0][0].message).toContain("reading 'maxDiscountPct'");
    expect(incrementMetric).toHaveBeenCalledWith('walmart.cart.order.failure', expect.objectContaining({ service: 'walmart-cart-order-api' }));
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });
  test.each([
    {},
    { ...VALID, items: [] },
    { ...VALID, items: [{ itemId: 'constructor', quantity: 1 }] },
    { ...VALID, items: [{ itemId: 'WM-58114027', quantity: 0 }] },
    { ...VALID, items: [{ itemId: 'WM-58114027', quantity: 13 }] },
    { ...VALID, items: [{ itemId: 'WM-58114027', quantity: 1, protectionPlan: 'toString' }] },
    { ...VALID, fulfillment: 'drone' },
    { ...VALID, zip: '7271' },
  ])('rejects invalid order %j before pricing', async (body) => {
    const response = await post(ORDER, body);
    expect(response.status).toBe(400);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
  test('invalid pickup requests do not declare incidents', async () => {
    for (const body of [{}, { storeId: 'STORE-4108' }, { ...SLOT, storeId: 'STORE-0001' }, { ...SLOT, slotId: 'tomorrow-2300' }]) {
      expect((await post(PICKUP, body)).status).toBe(400);
    }
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });
  test('pickup reservation returns 503, SEV-1 channel prefix and participant invitation', async () => {
    const response = await post(PICKUP, { ...SLOT, devinEmail: 'operator@example.com' });
    expect(response.status).toBe(503);
    const data = await response.json();
    expect(data).toMatchObject({ code: 'PICKUP_UNAVAILABLE', incident: { status: 'declared', channelPrefix: 'sev-1-incident' } });
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({ severity: 'SEV-1', service: 'walmart-pickup-slot-service', triggeredBy: 'operator@example.com' }));
    expect(queueIncidentChannelInvites).toHaveBeenCalledWith({ publicId: 518, userIds: ['U0BQZBHCNMA'] });
    expect(Sentry.captureException.mock.calls[0][0].message).toContain("reading 'reserve'");
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
  });
  test('pickup cap rejects the 51st valid request and ignores invalid requests', async () => {
    const headers = { 'X-Forwarded-For': '192.0.2.91' };
    for (let i = 0; i < 51; i++) expect((await post(PICKUP, {}, headers)).status).toBe(400);
    for (let i = 0; i < 50; i++) expect((await post(PICKUP, SLOT, headers)).status).toBe(503);
    expect((await post(PICKUP, SLOT, headers)).status).toBe(429);
  });
});
describe('Walmart pickup incident lifecycle', () => {
  test('concurrent and repeated reservations reuse the incident for five minutes', async () => {
    const { reservePickupSlot } = freshService();
    const results = await Promise.all([reservePickupSlot(SLOT), reservePickupSlot(SLOT), reservePickupSlot(SLOT)]);
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(new Set(results.map((r) => r.body.incident.runRef)).size).toBe(1);
    expect((await reservePickupSlot(SLOT)).body.incident.reused).toBe(true);
    const clock = jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 300001);
    try { await reservePickupSlot(SLOT); } finally { clock.mockRestore(); }
    expect(declareDatadogIncident).toHaveBeenCalledTimes(2);
  });
  test('declaration failures leave the outage visible and allow retry', async () => {
    const { reservePickupSlot } = freshService();
    declareDatadogIncident.mockResolvedValueOnce(null).mockRejectedValueOnce(new Error('Datadog 403'));
    expect((await reservePickupSlot(SLOT)).body.incident.status).toBe('unavailable');
    expect((await reservePickupSlot({ ...SLOT, devinEmail: {} })).body.incident.status).toBe('failed');
    expect(declareDatadogIncident).toHaveBeenLastCalledWith(expect.objectContaining({ triggeredBy: 'oncall/c/db261a21' }));
    expect((await reservePickupSlot(SLOT)).body.incident.status).toBe('declared');
  });
});
