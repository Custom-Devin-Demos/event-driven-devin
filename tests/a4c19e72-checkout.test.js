jest.mock('axios');
const axios = require('axios');
const express = require('express');
const { createHash } = require('crypto');
const fs = require('fs');
const path = require('path');
const service = require('../app/services/verticals/a4c19e72');
const alerts = require('../app/services/verticals/a4c19e72-alert');
const { postOncallAlert } = require('../app/services/oncall');
const router = require('../app/routes/verticals/a4c19e72');
const fridge = { sku: 'DEMO-FRIDGE', qty: 1 };
const battery = { sku: 'DEMO-BATTERY', qty: 1 };
const keys = ['LOWES_DEMO_TEAMS_ENABLED', 'LOWES_DEMO_SEND_TOKEN', 'LOWES_DEMO_APPROVED_CHANNEL', 'LOWES_DEMO_TEAMS_WEBHOOK_URL', 'LOWES_DEMO_APPROVED_WEBHOOK_SHA256'];
const original = Object.fromEntries(keys.map(k => [k, process.env[k]]));
beforeEach(() => { jest.clearAllMocks(); keys.forEach(k => delete process.env[k]); });
afterAll(() => keys.forEach(k => { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; }));

test('registers the customer using the existing vertical convention', () => {
  const { getCustomerConfig, listAliases } = require('../config/customers');
  expect(getCustomerConfig('a4c19e72').label).toContain('Lowe');
  expect(listAliases()['lowes']).toBe('a4c19e72');
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

test('existing on-call route selects a Teams dry-run even if Slack or live options are requested', async () => {
  process.env.ONCALL_TEAMS_WEBHOOK_URL = 'https://shared.webhook.office.com/never';
  try {
    const result = await postOncallAlert('a4c19e72', { destination: 'slack', sendDemo: true, skin: { alertDestination: 'devin' } });
    expect(result).toMatchObject({ ok: true, dryRun: true, sent: false, destination: 'teams' });
    expect(result.payload.attachments[0].content).toEqual(result.card);
    expect(result.payload.text).toContain('Synthetic incident specimen');
    expect(axios.post).not.toHaveBeenCalled();
  } finally { delete process.env.ONCALL_TEAMS_WEBHOOK_URL; }
});

test('live Teams delivery is closed without all explicit server-side approvals', async () => {
  await expect(alerts.sendApprovedDemo({ token: 'x', approval: 'Demo only' })).rejects.toMatchObject({ status: 403 });
  expect(axios.post).not.toHaveBeenCalled();
});

test('approved transport sends the preview payload only to the pinned demo webhook, with rate limiting', async () => {
  const token = 'test-only-approval-token-32-characters';
  const url = 'https://demo.webhook.office.com/workflows/test';
  process.env.LOWES_DEMO_TEAMS_ENABLED = 'true';
  process.env.LOWES_DEMO_SEND_TOKEN = token;
  process.env.LOWES_DEMO_APPROVED_CHANNEL = 'Dedicated synthetic demo';
  process.env.LOWES_DEMO_TEAMS_WEBHOOK_URL = url;
  process.env.LOWES_DEMO_APPROVED_WEBHOOK_SHA256 = 'bad';
  await expect(alerts.sendApprovedDemo({ token, approval: 'Dedicated synthetic demo' })).rejects.toMatchObject({ status: 403 });
  process.env.LOWES_DEMO_APPROVED_WEBHOOK_SHA256 = createHash('sha256').update(url).digest('hex');
  await expect(alerts.sendApprovedDemo({ token: 'wrong', approval: 'Dedicated synthetic demo' })).rejects.toMatchObject({ status: 403 });
  await expect(alerts.sendApprovedDemo({ token, approval: 'Unapproved channel' })).rejects.toMatchObject({ status: 403 });
  axios.post.mockResolvedValue({ status: 202 });
  await expect(alerts.sendApprovedDemo({ token, approval: 'Dedicated synthetic demo' })).resolves.toMatchObject({ sent: true, dryRun: false, webhookAccepted: true });
  expect(axios.post).toHaveBeenCalledWith(url, alerts.previewAlert().payload, expect.objectContaining({ maxRedirects: 0, timeout: 10000 }));
  await expect(alerts.sendApprovedDemo({ token, approval: 'Dedicated synthetic demo' })).rejects.toMatchObject({ status: 429 });
});

describe('HTTP surface', () => {
  let server, base;
  beforeAll(async () => { const app = express(); app.use(express.json()); app.use(router); server = app.listen(0); await new Promise(resolve => server.once('listening', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
  afterAll(() => new Promise(resolve => server.close(resolve)));
  test('catalog is synthetic and live send is forbidden by default', async () => {
    const response = await fetch(`${base}/api/a4c19e72/catalog`);
    expect((await response.json()).products).toHaveLength(3);
    const denied = await fetch(`${base}/api/a4c19e72/teams/send`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(denied.status).toBe(403);
  });
  test('healthy checkout returns 200; invalid cart returns 400', async () => {
    for (const [items, status] of [[[battery], 200], [[], 400]]) {
      const response = await fetch(`${base}/api/a4c19e72/checkout`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items, fulfillment: 'pickup' }) });
      expect(response.status).toBe(status);
    }
  });
});
