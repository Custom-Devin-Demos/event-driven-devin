jest.mock('axios');
const axios = require('axios');
const express = require('express');
jest.mock('../app/services/slack', () => ({ ownerRotation: x => x, postMessage: jest.fn(), postThreadReply: jest.fn(), lookupSlackUserByEmail: jest.fn() }));
jest.mock('../app/services/devin-api', () => ({ createDevinSession: jest.fn() }));
const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const fs = require('fs');
const path = require('path');
const service = require('../app/services/verticals/a4c19e72');
const { postOncallAlert } = require('../app/services/oncall');
const router = require('../app/routes/verticals/a4c19e72');
const fridge = { sku: 'DEMO-FRIDGE', qty: 1 };
const battery = { sku: 'DEMO-BATTERY', qty: 1 };
const keys = ['LOWES_DEMO_LIVE_TEAMS', 'ONCALL_TEAMS_WEBHOOK_URL', 'ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI', 'SLACK_ONCALL_BOT_TOKEN', 'SLACK_ONCALL_ALERTS_CHANNEL_ID'];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
beforeEach(() => { jest.clearAllMocks(); keys.forEach(k => delete process.env[k]); });
afterAll(() => keys.forEach(k => { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; }));

test('registers the customer using the existing vertical convention', () => {
  const { getCustomerConfig, listAliases } = require('../config/customers');
  expect(getCustomerConfig('a4c19e72').label).toContain('Lowe');
  expect(listAliases()['lowes']).toBe('a4c19e72');
  expect(require('../config/oncall-skins').getOncallSkin('a4c19e72')).toMatchObject({ alertDestination: 'teams', teamsWebhookEnv: 'ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI' });
  service.CATALOG.forEach(p => expect(fs.existsSync(path.join(__dirname, '../app/public', p.image))).toBe(true));
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

test('existing on-call route previews the standard card without any send, session or Slack fallback', async () => {
  process.env.ONCALL_TEAMS_WEBHOOK_URL = 'https://shared.webhook.office.com/never';
  const result = await postOncallAlert('a4c19e72', { destination: 'slack', sendDemo: true, skin: { alertDestination: 'devin' } });
  expect(result).toMatchObject({ ok: true, dryRun: true, sent: false, destination: 'teams' });
  expect(result.payload.attachments[0].content).toEqual(result.card);
  expect(result.payload.text).toContain('Synthetic demo alert');
  expect(result.payload.text).toContain('scenario branch: devin/lowes-cart-b5f26e97');
  expect(result.payload.text).toContain('not an observed store');
  expect(axios.post).not.toHaveBeenCalled();
  expect(postMessage).not.toHaveBeenCalled();
  expect(createDevinSession).not.toHaveBeenCalled();
});

test('approved live mode uses the standard Teams sender and channel-owned responder, not an app-created duplicate', async () => {
  process.env.LOWES_DEMO_LIVE_TEAMS = 'true';
  process.env.ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI = 'https://demo.webhook.office.com/workflows/test';
  process.env.SLACK_ONCALL_BOT_TOKEN = 'test-only';
  process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'CNEVERSEND';
  axios.post.mockResolvedValue({ status: 202 });
  const result = await postOncallAlert('a4c19e72', { destination: 'slack', devinOrgId: 'org-ignored', devinUserId: 'ignored' });
  expect(result).toMatchObject({ ok: true, teams: true, sent: true, dryRun: false, responderManaged: true });
  expect(result.sessionUrl).toBeUndefined();
  expect(axios.post).toHaveBeenCalledTimes(1);
  expect(axios.post).toHaveBeenCalledWith(process.env.ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI, expect.objectContaining({ type: 'message' }), expect.objectContaining({ maxRedirects: 0 }));
  expect(axios.post.mock.calls[0][1].text).toContain('Teams responder configured to run as Eashan');
  expect(postMessage).not.toHaveBeenCalled();
  expect(createDevinSession).not.toHaveBeenCalled();
});

test('dry-run and live mode use identical card construction', async () => {
  const random = jest.spyOn(Math, 'random').mockReturnValue(0.5);
  try {
    const options = { destination: 'teams', runRef: 'identical-rehearsal-ref' };
    const preview = await postOncallAlert('a4c19e72', options);
    process.env.LOWES_DEMO_LIVE_TEAMS = 'true';
    process.env.ONCALL_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
    axios.post.mockResolvedValue({ status: 202 });
    await postOncallAlert('a4c19e72', options);
    const normalized = value => JSON.stringify(value).replace(/\d{4}-\d{2}-\d{2}T[0-9:.]+Z/g, '<timestamp>');
    expect(normalized(axios.post.mock.calls[0][1])).toEqual(normalized(preview.payload));
  } finally { random.mockRestore(); }
});

test.each([undefined, 'https://not-teams.example/test'])('live mode with missing/invalid Teams config fails closed: %p', webhook => {
  process.env.LOWES_DEMO_LIVE_TEAMS = 'true';
  if (webhook) process.env.ONCALL_TEAMS_WEBHOOK_URL = webhook;
  return expect(postOncallAlert('a4c19e72', { destination: 'slack' })).resolves.toMatchObject({ ok: false, sent: false });
});

test('Teams transport failure cannot post to Slack or create an app-side session', async () => {
  process.env.LOWES_DEMO_LIVE_TEAMS = 'true';
  process.env.ONCALL_TEAMS_WEBHOOK_URL = 'https://demo.webhook.office.com/workflows/test';
  axios.post.mockRejectedValue(new Error('Mock Teams unavailable'));
  await expect(postOncallAlert('a4c19e72')).resolves.toMatchObject({ ok: false });
  expect(postMessage).not.toHaveBeenCalled();
  expect(createDevinSession).not.toHaveBeenCalled();
});

describe('HTTP surface', () => {
  let server, base;
  beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); server = app.listen(0); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
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
});
