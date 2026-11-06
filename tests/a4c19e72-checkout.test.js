jest.mock('axios');
const axios = require('axios');
const express = require('express');
jest.mock('../app/services/slack', () => ({ postAlertToSlack: jest.fn(), postBugReportToTriage: jest.fn(), postDevinSessionLink: jest.fn() }));
jest.mock('../app/services/devin-api', () => ({ createDevinSession: jest.fn() }));
jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));
const { scheduleVulnerablePR } = require('../app/services/sonar-pr-trigger');
const { postAlertToSlack, postBugReportToTriage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const fs = require('fs');
const path = require('path');
const service = require('../app/services/verticals/a4c19e72');
const { reportCheckoutError } = require('../app/services/verticals/a4c19e72-alert');
const { runWithAlertDestination, alertDestinationFromCookie } = require('../app/services/alert-destination');
const error = new TypeError("Cannot read properties of undefined (reading 'fee')");
const report = (input = {}) => runWithAlertDestination('teams', () => reportCheckoutError(error, input));
const router = require('../app/routes/verticals/a4c19e72');
const fridge = { sku: 'DEMO-FRIDGE', qty: 1 };
const battery = { sku: 'DEMO-BATTERY', qty: 1 };
const keys = ['NODE_ENV', 'CI', 'LOWES_DEMO_DRY_RUN', 'AUTOMATIONS_TEAMS_WEBHOOK_URL'];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
let testTime = Date.now();
beforeEach(() => { jest.clearAllMocks(); keys.forEach(k => delete process.env[k]); testTime += 60_001; jest.spyOn(Date, 'now').mockReturnValue(testTime); });
afterAll(() => jest.restoreAllMocks());
afterAll(() => keys.forEach(k => { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; }));

test('registers the customer using the existing vertical convention', () => {
  const { getCustomerConfig, listAliases } = require('../config/customers');
  expect(getCustomerConfig('a4c19e72').label).toContain('Lowe');
  expect(listAliases()['lowes']).toBe('a4c19e72');
  service.CATALOG.forEach(p => expect(fs.existsSync(path.join(__dirname, '../app/public', p.image))).toBe(true));
});

test('storefront uses the supplied logo and local licensed fonts without a sign-in flow', () => {
  const publicDir = path.join(__dirname, '../app/public');
  const html = fs.readFileSync(path.join(publicDir, 'verticals/a4c19e72.html'), 'utf8');
  expect(html).toContain('<img src="/verticals/lowes-assets/lowes-logo.png" alt="Lowe’s"');
  expect(html).not.toContain('<text x="65"');
  expect(html).toContain('Demo only · Synthetic shopping cart');
  expect(html).toContain('Guest demo · No sign-in');
  expect(html).not.toContain('type="password"');
  for (const asset of ['lowes-logo.png', 'Poppins-Regular.ttf', 'Poppins-SemiBold.ttf', 'OFL.txt']) {
    expect(fs.statSync(path.join(publicDir, 'verticals/lowes-assets', asset)).size).toBeGreaterThan(0);
  }
  expect(fs.readFileSync(path.join(publicDir, 'verticals/lowes-assets/OFL.txt'), 'utf8')).toContain('SIL OPEN FONT LICENSE');
});

test('delivery succeeds with server-owned prices and no real order side effect', () => {
  const result = service.quoteCart({ items: [{ ...fridge, price: 1 }, battery] });
  expect(result).toMatchObject({ demo: true, success: true, subtotal: 1798, fee: 79, tax: 130.36, total: 2007.36 });
  expect(result.confirmation).toMatch(/^DEMO-/);
  expect(axios.post).not.toHaveBeenCalled();
});

test('parcel-only pickup is a healthy control at either store', () => {
  service.STORES.forEach(store => expect(service.quoteCart({ items: [battery], fulfillment: 'pickup', store })).toMatchObject({ success: true, store, subtotal: 199, fee: 0, total: 213.43 }));
});

test('incident baseline reproduces missing bulky pickup policy without losing cart data', () => {
  const cart = { items: [fridge, battery], fulfillment: 'delivery' };
  expect(service.quoteCart(cart).success).toBe(true);
  cart.fulfillment = 'pickup';
  expect(() => service.quoteCart(cart)).toThrow("Cannot read properties of undefined (reading 'fee')");
  expect(cart.items).toEqual([fridge, battery]);
});

test.each([
  {}, { items: [] }, { items: [null] }, { items: [{ sku: '__proto__', qty: 1 }] },
  { items: [fridge, fridge] }, { items: [{ ...fridge, qty: 0 }] }, { items: [{ ...fridge, qty: 1.5 }] },
  { items: [{ ...fridge, qty: 6 }] }, { items: [fridge], fulfillment: '__proto__' }, { items: [fridge], store: 'Mars' },
])('invalid carts fail before creating any incident: %p', cart => {
  expect(() => service.quoteCart(cart)).toThrow();
  try { service.quoteCart(cart); } catch (error) { expect(error.status).toBe(400); }
  expect(axios.post).not.toHaveBeenCalled();
});

test('default rehearsal previews the same checkout Teams card without send or session', async () => {
  process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  const result = await report({ store: 'South Charlotte', fulfillment: 'pickup' });
  expect(result).toMatchObject({ ok: true, dryRun: true, sent: false, destination: 'teams' });
  expect(result.payload.attachments[0].content).toEqual(result.card);
  expect(result.payload.text).toContain('Synthetic demo alert');
  expect(result.payload.text).toContain('devin/lowes-cart-b5f26e97');
  expect(result.payload.text).toContain('Observed checkout: store=South Charlotte');
  expect(axios.post).not.toHaveBeenCalled();
  expect(createDevinSession).not.toHaveBeenCalled();
});

test('official production runtime automatically uses the real Pepsi pipeline with no duplicate session or vulnerable PR', async () => {
  process.env.NODE_ENV = 'production';
  process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  axios.post.mockResolvedValue({ status: 202 });
  const result = await report({ devinOrgId: 'org-ignored', devinUserId: 'ignored' });
  expect(result).toMatchObject({ ok: true, sent: true, dryRun: false, responderManaged: true });
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(axios.post).toHaveBeenCalledWith(process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL, expect.objectContaining({ type: 'message' }), expect.objectContaining({ maxRedirects: 0 }));
  expect(postAlertToSlack).not.toHaveBeenCalled();
  expect(postBugReportToTriage).not.toHaveBeenCalled();
  expect(createDevinSession).not.toHaveBeenCalled();
  expect(scheduleVulnerablePR).not.toHaveBeenCalled();
});

test('dry-run payload equals the real pipeline payload', async () => {
  const preview = await report();
  process.env.NODE_ENV = 'production';
  process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  axios.post.mockResolvedValue({ status: 202 });
  await report();
  const normalized = value => JSON.stringify(value).replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<timestamp>');
  expect(normalized(axios.post.mock.calls[0][1])).toEqual(normalized(preview.payload));
});

test.each([undefined, 'https://not-teams.example/test'])('missing/invalid Teams config cannot fall back to Slack: %p', async webhook => {
  process.env.NODE_ENV = 'production';
  if (webhook) process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = webhook;
  expect(await report()).toMatchObject({ ok: true, dryRun: true, sent: false, reason: 'missing-teams-target' });
  expect(postAlertToSlack).not.toHaveBeenCalled();
  expect(axios.post).not.toHaveBeenCalled();
});

test.each(['slack', null])('live mode respects saved destination and refuses Slack: %p', async destination => {
  process.env.NODE_ENV = 'production';
  process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  expect(await runWithAlertDestination(destination, () => reportCheckoutError(error))).toMatchObject({ ok: false, sent: false });
  expect(axios.post).not.toHaveBeenCalled();
  expect(postAlertToSlack).not.toHaveBeenCalled();
});

test('failed Teams transport does not send Slack or start an app-side session', async () => {
  process.env.NODE_ENV = 'production';
  process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  axios.post.mockRejectedValue(new Error('Mock Teams unavailable'));
  expect(await report()).toMatchObject({ ok: false, sent: false });
  expect(postAlertToSlack).not.toHaveBeenCalled();
  expect(createDevinSession).not.toHaveBeenCalled();
});

test.each([
  ['test', undefined, undefined, 'local-or-test-runtime'],
  ['development', undefined, undefined, 'local-or-test-runtime'],
  ['production', 'true', undefined, 'ci-runtime'],
  ['production', undefined, 'true', 'explicit-dry-run'],
])('safe rehearsal in %s / CI=%s / explicit=%s even with a valid target', async (runtime, ci, dryRun, reason) => {
  process.env.NODE_ENV = runtime;
  if (ci) process.env.CI = ci;
  if (dryRun) process.env.LOWES_DEMO_DRY_RUN = dryRun;
  process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  expect(await report()).toMatchObject({ dryRun: true, sent: false, reason });
  expect(axios.post).not.toHaveBeenCalled();
  expect(postAlertToSlack).not.toHaveBeenCalled();
});

test('concurrent and repeated live failures are capped, including failed delivery attempts', async () => {
  process.env.NODE_ENV = 'production';
  process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  axios.post.mockRejectedValue(new Error('Mock transport down'));
  const results = await Promise.all([report(), report(), report()]);
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(results.filter(r => r.throttled)).toHaveLength(2);
  Date.now.mockReturnValue(testTime + 60_001);
  axios.post.mockResolvedValue({ status: 202 });
  expect(await report()).toMatchObject({ sent: true });
  expect(axios.post).toHaveBeenCalledTimes(2);
});

describe('HTTP surface', () => {
  let server, base;
  beforeAll(async () => { const app = express(); app.use(express.json()); app.use((req, res, next) => runWithAlertDestination(alertDestinationFromCookie(req.headers.cookie), next)); app.use(router); server = app.listen(0); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  test('catalog is synthetic and bespoke send endpoint does not exist', async () => {
    const response = await fetch(`${base}/api/a4c19e72/catalog`);
    expect((await response.json()).products).toHaveLength(3);
    const denied = await fetch(`${base}/api/a4c19e72/teams/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(404);
  });
  test('healthy checkout returns 200; invalid cart returns 400', async () => {
    for (const [items, status] of [[[battery], 200], [[], 400]]) {
      const response = await fetch(`${base}/api/a4c19e72/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, fulfillment: 'pickup' }) });
      expect(response.status).toBe(status);
    }
  });
  test('failing checkout itself creates preview; no second client trigger is needed', async () => {
    const response = await fetch(`${base}/api/a4c19e72/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [fridge, battery], fulfillment: 'pickup', store: 'South Charlotte' }) });
    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.alert).toMatchObject({ ok: true, dryRun: true, sent: false });
    expect(data.alert.payload.text).toContain('Observed checkout: store=South Charlotte');
    expect(axios.post).not.toHaveBeenCalled();
  });
  test('checkout carries persisted Teams cookie to the existing transport', async () => {
    process.env.NODE_ENV = 'production';
    process.env.AUTOMATIONS_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
    axios.post.mockResolvedValue({ status: 202 });
    const response = await fetch(`${base}/api/a4c19e72/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: 'alert_destination=teams' }, body: JSON.stringify({ items: [fridge], fulfillment: 'pickup' }) });
    expect(response.status).toBe(500);
    expect((await response.json()).alert).toMatchObject({ ok: true, sent: true, responderManaged: true });
    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(createDevinSession).not.toHaveBeenCalled();
  });
});
