let mockAlertDestination;
jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../app/services/devin-session', () => ({
  ...jest.requireActual('../app/services/devin-session'),
  createSessionAndAlert: jest.fn(() => { mockAlertDestination = require('../app/services/alert-destination').currentAlertDestination(); return Promise.resolve({ sessionId: 'devin-test' }); }),
}));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Sentry = require('@sentry/node');
const { createSessionAndAlert, buildPrompt } = require('../app/services/devin-session');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const svc = require('../app/services/verticals/9dc8b009');
const router = require('../app/routes/verticals/9dc8b009');
const { getCustomerConfig, listAliases } = require('../config/customers');

const ASSETS = path.join(__dirname, '../app/public/verticals/9dc8b009-assets');
const TWINGO = 'twingo-etech';
beforeEach(() => { jest.clearAllMocks(); svc.resetAlertCooldown(); });

describe('registration and assets', () => {
  test('registers the slug, aliases and Slack routing without operator identity', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ triggerMode: 'api', githubOrg: 'COG-GTM', slackChannelId: 'C0BNWUGCWBS' });
    for (const alias of ['renault', 'renault-order']) expect(listAliases()[alias]).toBe('9dc8b009');
    const config = require('../config/customers/9dc8b009');
    expect(config.devinUserId).toBeUndefined(); expect(config.devinOrgId).toBeUndefined();
  });

  test('page is French, carries the mock banner and serves local assets only', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/9dc8b009.html'), 'utf8');
    expect(html).toMatch(/<html lang="fr-FR">/);
    expect(html).toContain('THIS IS A MOCK');
    expect(html).toContain('Commander en ligne');
    expect(html).not.toMatch(/src="https?:/);
    const js = fs.readFileSync(path.join(ASSETS, 'order.js'), 'utf8');
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail', 'localStorage']) expect(js).not.toContain(key);
    expect(js).toContain("'/api/9dc8b009/orders'");
    expect(js).toContain("get('reports') !== 'off'");
    for (const f of ['Montserrat-Regular.woff2', 'Montserrat-Medium.woff2', 'Montserrat-Bold.woff2']) {
      expect(fs.statSync(path.join(ASSETS, f)).size).toBeGreaterThan(1000);
    }
  });

  test('the Twingo is the default (first) model and only has a provisional score', () => {
    expect(svc.getCatalog().models[0]).toMatchObject({ id: TWINGO, isNew: true });
    expect(svc.ADEME_SCORES[TWINGO]).toBeUndefined();
    expect(svc.PROVISIONAL_SCORES[TWINGO]).toBeDefined();
  });
});

describe('order pricing', () => {
  test.each([
    ['r5-etech', 'standard', false, 32990, 3100, 29890],
    ['r4-etech', 'modeste', true, 35490, 4200, 32480],
    ['scenic-etech', 'standard', false, 49990, 3100, 46890],
  ])('%s order (%s, wallbox %s) is confirmed', async (modelId, household, wallbox, vehiclePrice, incentive, total) => {
    const order = await svc.placeOrder({ modelId, household, wallbox, suppressAlerts: true });
    expect(order).toMatchObject({ success: true, status: 'CONFIRMED', vehiclePrice, incentive, total, deposit: 250, scoreSource: 'ADEME', incentiveEligible: true, orderId: expect.stringMatching(/^RNO-\d{4}-\d{7}$/) });
    expect(svc.getOrder(order.orderId)).toBe(order);
  });

  test('paint surcharge is added to the vehicle price', async () => {
    const order = await svc.placeOrder({ modelId: 'r5-etech', paintId: 'jaune-pop', suppressAlerts: true });
    expect(order).toMatchObject({ vehiclePrice: 33790, total: 30690, paint: 'Jaune Pop' });
  });

  test.each([[{}, 'modelId'], [{ modelId: 'clio' }, 'modelId'], [{ modelId: TWINGO, paintId: 'rose' }, 'paintId'], [{ modelId: TWINGO, household: 'vip' }, 'household']])('invalid input %j is a 400', async (input, field) => {
    await expect(svc.placeOrder(input)).rejects.toMatchObject({ status: 400, field });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});

describe('Twingo environmental score failure', () => {
  test('captures Sentry and fires one instant alert', async () => {
    await expect(svc.placeOrder({ modelId: TWINGO, devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com' })).rejects.toMatchObject({
      name: 'TypeError', message: "Cannot read properties of undefined (reading 'score')", status: 500, code: 'RNO-ORD-5031', reference: expect.stringMatching(/^RNO-/),
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ customer: '9dc8b009', service: svc.SERVICE, culprit: svc.CULPRIT, skipVulnerablePr: true, extra: { modelId: TWINGO } });
    expect(alert).not.toHaveProperty('devinUserId');
    expect(mockAlertDestination).toBe('slack');
    expect(isInstantPathEvent(alert)).toBe(true);
    expect(buildPrompt(alert)).toContain('9dc8b009');
    expect(alert.promptAppendix).toContain('COG-GTM/event-driven-devin');
    expect(alert.promptAppendix).toContain('never merge or deploy');
    expect(alert.promptAppendix).toContain('request Devin Review');
    for (const env of ['1440x900', '390x844', '412x915']) expect(alert.promptAppendix).toContain(env);
    expect(alert.promptAppendix).toContain('Open the PR only after all three pass on the same final commit');
  });

  test('alerts stay on Slack when the hub picked Teams', async () => {
    const { runWithAlertDestination } = require('../app/services/alert-destination');
    await runWithAlertDestination('teams', () => expect(svc.placeOrder({ modelId: TWINGO })).rejects.toMatchObject({ status: 500 }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(mockAlertDestination).toBe('slack');
  });

  test('a second failure inside the cooldown is captured but does not alert again', async () => {
    await expect(svc.placeOrder({ modelId: TWINGO })).rejects.toBeInstanceOf(TypeError);
    await expect(svc.placeOrder({ modelId: TWINGO, wallbox: true })).rejects.toBeInstanceOf(TypeError);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('suppressed alerts keep the failure but skip alerting', async () => {
    await expect(svc.placeOrder({ modelId: TWINGO, suppressAlerts: true })).rejects.toBeInstanceOf(TypeError);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('an alert that was not delivered does not start the cooldown', async () => {
    createSessionAndAlert.mockResolvedValueOnce(null);
    await expect(svc.placeOrder({ modelId: TWINGO })).rejects.toBeInstanceOf(TypeError);
    await new Promise(setImmediate);
    await expect(svc.placeOrder({ modelId: TWINGO })).rejects.toBeInstanceOf(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test('alert delivery failures never replace the original error', async () => {
    createSessionAndAlert.mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(svc.placeOrder({ modelId: TWINGO })).rejects.toBeInstanceOf(TypeError);
    await new Promise(resolve => setImmediate(resolve));
    expect(require('../app/telemetry/logger').error).toHaveBeenCalledWith('Failed to create Devin session for online order failure', expect.objectContaining({ error: 'notification unavailable' }));
  });
});

describe('HTTP contract', () => {
  let server; let port;
  beforeAll(done => {
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { req.requestId = 'req-test'; next(); }); app.use(router);
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
  });
  afterAll(done => { server.close(done); });
  const call = (method, url, body, headers = {}) => new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json', ...headers } }, res => {
      let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
    });
    req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
  });

  test('catalog exposes models and options but not the score tables', async () => {
    const res = await call('GET', '/api/9dc8b009/catalog');
    expect(res.status).toBe(200); expect(res.body.models).toHaveLength(4); expect(res.body.deposit).toBe(250);
    expect(JSON.stringify(res.body)).not.toMatch(/ADEME|dossier|score/i);
  });

  test('500 on Twingo, 200 otherwise, 400 on invalid input, 404 on unknown orders', async () => {
    expect(await call('POST', '/api/9dc8b009/orders', { modelId: TWINGO, devinUserId: 'route-user', devinOrgId: 'route-org' }))
      .toMatchObject({ status: 500, body: { success: false, code: 'RNO-ORD-5031', errorClass: 'TypeError', reference: expect.stringMatching(/^RNO-/) } });
    expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('devinUserId');
    expect(createSessionAndAlert.mock.calls[0][0]).not.toHaveProperty('devinOrgId');
    jest.clearAllMocks(); svc.resetAlertCooldown();
    expect(await call('POST', '/api/9dc8b009/orders', { modelId: TWINGO, reports: 'off' })).toMatchObject({ status: 500 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    const ok = await call('POST', '/api/9dc8b009/orders', { modelId: 'r5-etech', wallbox: true });
    expect(ok).toMatchObject({ status: 200, body: { success: true, total: 31080 } });
    expect(await call('GET', `/api/9dc8b009/orders/${ok.body.orderId}`)).toMatchObject({ status: 200, body: { orderId: ok.body.orderId } });
    expect(await call('GET', '/api/9dc8b009/orders/RNO-0000-0000000')).toMatchObject({ status: 404, body: { code: 'ORDER_NOT_FOUND' } });
    expect(await call('POST', '/api/9dc8b009/orders', { modelId: 'clio' })).toMatchObject({ status: 400, body: { field: 'modelId' } });
    expect(await call('POST', '/api/9dc8b009/orders')).toMatchObject({ status: 400 });
  });
});
