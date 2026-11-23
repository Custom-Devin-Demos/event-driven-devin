jest.mock('@sentry/node', () => ({ captureException: jest.fn() }));
jest.mock('../app/services/devin-session', () => ({
  ...jest.requireActual('../app/services/devin-session'),
  createSessionAndAlert: jest.fn(() => Promise.resolve({ sessionId: 'devin-test' })),
}));
jest.mock('../app/telemetry/logger', () => ({ info: jest.fn(), error: jest.fn(), warn: jest.fn() }));

const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const Sentry = require('@sentry/node');
const { createSessionAndAlert, buildPrompt } = require('../app/services/devin-session');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const svc = require('../app/services/verticals/1fc7edc2');
const router = require('../app/routes/verticals/1fc7edc2');
const { getCustomerConfig, listAliases } = require('../config/customers');

const ASSETS = path.join(__dirname, '../app/public/verticals/1fc7edc2-assets');
const THB = 'ch-81f3';
beforeEach(() => { jest.clearAllMocks(); svc.resetAlertCooldown(); });

describe('registration and assets', () => {
  test('registers the slug, aliases and Slack routing without operator identity', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ triggerMode: 'api', githubOrg: 'COG-GTM', slackChannelId: 'C0BNWUGCWBS' });
    for (const alias of ['isracard', 'isracard-installments']) expect(listAliases()[alias]).toBe('1fc7edc2');
    const config = require('../config/customers/1fc7edc2');
    expect(config.devinUserId).toBeUndefined(); expect(config.devinOrgId).toBeUndefined();
  });

  test('page is RTL Hebrew, carries the mock banner and serves local assets only', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/1fc7edc2.html'), 'utf8');
    expect(html).toMatch(/<html dir="rtl" lang="he-IL">/);
    expect(html).toContain('THIS IS A MOCK');
    expect(html).toContain('פריסת חיובים');
    expect(html).not.toMatch(/src="https?:/);
    const js = fs.readFileSync(path.join(ASSETS, 'spread.js'), 'utf8');
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) expect(js).toContain(`'${key}'`);
    expect(js).toContain("'/api/1fc7edc2/installment-plans'");
    expect(js).toContain("get('reports') !== 'off'");
    for (const f of ['OpenSansHebrew-Regular.woff2', 'OpenSansHebrew-Bold.woff2', 'OpenSansHebrew-ExtraBold.woff2']) {
      expect(fs.statSync(path.join(ASSETS, f)).size).toBeGreaterThan(1000);
    }
  });

  test('the THB charge is the default (first) charge', () => {
    expect(svc.getAccount().charges[0]).toMatchObject({ id: THB, currency: 'THB' });
    expect(svc.REPRESENTATIVE_RATES.THB).toBeUndefined();
    expect(svc.CROSS_RATES.THB).toBeDefined();
  });
});

describe('installment pricing', () => {
  test.each([
    ['EUR', 'ch-77a0', 4469.94],
    ['ILS', 'ch-6c21', 4820],
    ['USD', 'ch-5b9e', 5527.17],
  ])('%s charge is approved', async (_cur, chargeId, billingAmount) => {
    const plan = await svc.requestPlan({ chargeId, payments: 12, suppressAlerts: true });
    expect(plan).toMatchObject({ success: true, status: 'APPROVED', billingAmount, payments: 12, annualRate: 8.9, planId: expect.stringMatching(/^IC-\d{4}-\d{7}$/) });
    expect(plan.totalCost).toBeCloseTo(plan.monthlyPayment * 12, 1);
    expect(svc.getPlan(plan.planId)).toBe(plan);
  });

  test('plan rate follows the payment tiers', () => {
    expect([3, 6, 10, 12, 18, 24, 36].map(svc.planRate)).toEqual([6.9, 6.9, 8.9, 8.9, 10.9, 10.9, 11.9]);
  });

  test('charges under the ₪500 minimum are rejected with 400', async () => {
    await expect(svc.requestPlan({ chargeId: 'ch-3a17', payments: 3 })).rejects.toMatchObject({ status: 400, field: 'chargeId' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([[{ payments: 12 }, 'chargeId'], [{ chargeId: THB, payments: 7 }, 'payments'], [{ chargeId: 'nope', payments: 12 }, 'chargeId']])('invalid input %j is a 400', async (input, field) => {
    await expect(svc.requestPlan(input)).rejects.toMatchObject({ status: 400, field });
  });
});

describe('THB conversion failure', () => {
  test('captures Sentry and fires one instant alert carrying the presenter identity', async () => {
    await expect(svc.requestPlan({ chargeId: THB, payments: 12, devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com' })).rejects.toMatchObject({
      name: 'TypeError', message: "Cannot read properties of undefined (reading 'rate')", status: 500, code: 'ISR-INS-4221', reference: expect.stringMatching(/^IC-/),
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ customer: '1fc7edc2', service: svc.SERVICE, culprit: svc.CULPRIT, devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com', extra: { currency: 'THB', payments: 12 } });
    expect(JSON.stringify(alert)).not.toMatch(/דנה כהן/);
    expect(isInstantPathEvent(alert)).toBe(true);
    expect(buildPrompt(alert)).toContain('1fc7edc2');
    expect(alert.promptAppendix).toContain('COG-GTM/event-driven-devin');
    expect(alert.promptAppendix).toContain('never merge or deploy');
    expect(alert.promptAppendix).toContain('request Devin Review');
  });

  test('a second failure inside the cooldown is captured but does not alert again', async () => {
    await expect(svc.requestPlan({ chargeId: THB, payments: 12 })).rejects.toBeInstanceOf(TypeError);
    await expect(svc.requestPlan({ chargeId: THB, payments: 6 })).rejects.toBeInstanceOf(TypeError);
    expect(Sentry.captureException).toHaveBeenCalledTimes(2);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('suppressed alerts keep the failure but skip alerting', async () => {
    await expect(svc.requestPlan({ chargeId: THB, payments: 12, suppressAlerts: true })).rejects.toBeInstanceOf(TypeError);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('alert delivery failures never replace the original error', async () => {
    createSessionAndAlert.mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(svc.requestPlan({ chargeId: THB, payments: 12 })).rejects.toBeInstanceOf(TypeError);
    await new Promise(resolve => setImmediate(resolve));
    expect(require('../app/telemetry/logger').error).toHaveBeenCalledWith('Failed to create Devin session for installment plan failure', expect.objectContaining({ error: 'notification unavailable' }));
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

  test('account exposes the card and charges but not the rate tables', async () => {
    const res = await call('GET', '/api/1fc7edc2/account');
    expect(res.status).toBe(200); expect(res.body.charges).toHaveLength(6); expect(res.body.card.availableCredit).toBe(18360);
    expect(JSON.stringify(res.body)).not.toMatch(/perUsd|REPRESENTATIVE/);
  });

  test('500 on THB, 200 otherwise, 400 on invalid input, 404 on unknown plans', async () => {
    expect(await call('POST', '/api/1fc7edc2/installment-plans', { chargeId: THB, payments: 12, devinUserId: 'route-user', devinOrgId: 'route-org' }))
      .toMatchObject({ status: 500, body: { success: false, code: 'ISR-INS-4221', errorClass: 'TypeError', reference: expect.stringMatching(/^IC-/) } });
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ devinUserId: 'route-user', devinOrgId: 'route-org' }));
    jest.clearAllMocks(); svc.resetAlertCooldown();
    expect(await call('POST', '/api/1fc7edc2/installment-plans', { chargeId: THB, payments: 12, reports: 'off' })).toMatchObject({ status: 500 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    const ok = await call('POST', '/api/1fc7edc2/installment-plans', { chargeId: 'ch-77a0', payments: 24 });
    expect(ok).toMatchObject({ status: 200, body: { success: true, annualRate: 10.9 } });
    expect(await call('GET', `/api/1fc7edc2/installment-plans/${ok.body.planId}`)).toMatchObject({ status: 200, body: { planId: ok.body.planId } });
    expect(await call('GET', '/api/1fc7edc2/installment-plans/IC-0000-0000000')).toMatchObject({ status: 404, body: { code: 'PLAN_NOT_FOUND' } });
    expect(await call('POST', '/api/1fc7edc2/installment-plans', { chargeId: THB, payments: 5 })).toMatchObject({ status: 400, body: { field: 'payments' } });
    expect(await call('POST', '/api/1fc7edc2/installment-plans')).toMatchObject({ status: 400 });
  });
});
