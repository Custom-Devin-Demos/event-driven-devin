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
const { buildAlertBlocks } = require('../app/services/slack');
const svc = require('../app/services/verticals/ea2d0dbc');
const router = require('../app/routes/verticals/ea2d0dbc');
const { getCustomerConfig, listAliases } = require('../config/customers');
const gift = { sku: '4000391547', qty: 1 };
const standard = { sku: '4000414178', qty: 1 };
const oversized = { sku: '4000289982', qty: 1 };

beforeEach(() => jest.clearAllMocks());

describe('Marshalls Best Gift Ideas (ea2d0dbc)', () => {
  test('registers the hex slug and friendly alias without hard-coded operator identity', () => {
    expect(getCustomerConfig('ea2d0dbc')).toMatchObject({ label: 'Marshalls — Best Gift Ideas', triggerMode: 'api', githubOrg: 'COG-GTM' });
    expect(listAliases().marshalls).toBe('ea2d0dbc');
    const customer = require('../config/customers/ea2d0dbc');
    expect(customer.devinUserId).toBeUndefined();
    expect(customer.devinOrgId).toBeUndefined();
  });

  test('serves 24 original catalog images and all page assets locally', () => {
    expect(svc.CATALOG).toHaveLength(24);
    expect(new Set(svc.CATALOG.map(p => p.sku)).size).toBe(24);
    svc.CATALOG.forEach(p => {
      const bytes = fs.readFileSync(path.join(__dirname, '../app/public', p.image));
      expect(bytes.subarray(0, 2).toString('hex')).toBe('ffd8');
    });
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/ea2d0dbc.html'), 'utf8');
    const assets = [...html.matchAll(/(?:src=\"|url\(')(\/verticals\/ea2d0dbc-assets\/[^"')]+)/g)].map(m => m[1]);
    expect(assets.length).toBeGreaterThan(10);
    assets.forEach(file => expect(fs.existsSync(path.join(__dirname, '../app/public', file))).toBe(true));
    expect(html).toContain("fetch('/api/ea2d0dbc/checkout'");
  });

  test('standard checkout succeeds with server-owned prices and rounded totals', async () => {
    const result = await svc.placeOrder({ items: [{ ...standard, price: 0.01, shippingClass: 'gift-bundle' }] });
    expect(result).toMatchObject({ success: true, subtotal: 29.99, shipping: 9.99, tax: 1.87, total: 41.85, status: 'confirmed', currency: 'USD' });
    expect(result.orderNumber).toMatch(/^M-[A-F0-9]{8}$/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('SHIP89 applies only above the threshold and never waives oversized handling', async () => {
    expect(await svc.placeOrder({ items: [standard], promoCode: 'SHIP89' })).toMatchObject({ shipping: 9.99 });
    expect(await svc.placeOrder({ items: [{ ...standard, qty: 3 }], promoCode: ' ship89 ' })).toMatchObject({ subtotal: 89.97, shipping: 0, tax: 5.62, total: 95.59 });
    expect(await svc.placeOrder({ items: [oversized], promoCode: 'SHIP89' })).toMatchObject({ shipping: 14.99 });
    expect(await svc.placeOrder({ items: [oversized] })).toMatchObject({ shipping: 24.98 });
    expect(await svc.placeOrder({ items: [{ ...oversized, qty: 2 }] })).toMatchObject({ shipping: 39.97 });
  });

  test.each([0, -1, 11, 1.5, '1', null, undefined])('rejects quantity %p without an incident', async qty => {
    await expect(svc.placeOrder({ items: [{ ...standard, qty }] })).rejects.toMatchObject({ status: 400, code: 'INVALID_QUANTITY' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each([
    [{}, 'INVALID_BAG'],
    [{ items: [] }, 'INVALID_BAG'],
    [{ items: 'bad' }, 'INVALID_BAG'],
    [{ items: Array(25).fill(standard) }, 'INVALID_BAG'],
    [{ items: [null] }, 'UNKNOWN_PRODUCT'],
    [{ items: [{ sku: '__proto__', qty: 1 }] }, 'UNKNOWN_PRODUCT'],
    [{ items: [standard, standard] }, 'DUPLICATE_PRODUCT'],
    [{ items: [standard], promoCode: {} }, 'INVALID_PROMO'],
    [{ items: [standard], promoCode: 'INVALID' }, 'INVALID_PROMO'],
  ])('rejects malformed order %p without an incident', async (data, code) => {
    await expect(svc.placeOrder(data)).rejects.toMatchObject({ status: 400, code });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('the planted gift-bundle mismatch reports exactly one Sentry event and one incident', async () => {
    await expect(svc.placeOrder({ items: [gift], devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com' })).rejects.toMatchObject({
      name: 'TypeError', message: "Cannot read properties of undefined (reading 'handlingFee')", status: 500, code: 'CHECKOUT_FAILED',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(TypeError), expect.objectContaining({ tags: expect.objectContaining({ customer: svc.CUSTOMER, alert_path: 'instant' }) }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ customer: svc.CUSTOMER, service: svc.SERVICE, culprit: svc.CULPRIT, devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com', extra: { skus: [gift.sku], shippingClasses: ['gift-bundle'] } });
    expect(isInstantPathEvent(alert)).toBe(true);
    expect(isInstantPathEvent({ culprit: svc.CULPRIT, tags: [] })).toBe(true);
    const prompt = buildPrompt(alert);
    expect(prompt).toContain('ea2d0dbc');
    expect(alert.promptAppendix).toContain('COG-GTM/event-driven-devin');
    expect(alert.promptAppendix).toContain('pull request against main');
    expect(alert.promptAppendix).toContain('zero handling surcharge');
    const blocks = JSON.stringify(buildAlertBlocks(alert));
    expect(blocks).toContain('Marshalls');
    expect(blocks).toContain('handlingFee');
  });

  test('notification rejection does not replace the checkout error', async () => {
    createSessionAndAlert.mockRejectedValueOnce(new Error('delivery unavailable'));
    await expect(svc.placeOrder({ items: [gift] })).rejects.toBeInstanceOf(TypeError);
    await new Promise(resolve => setImmediate(resolve));
    expect(require('../app/telemetry/logger').error).toHaveBeenCalledWith('Failed to create Devin session for Marshalls checkout', expect.objectContaining({ error: 'delivery unavailable' }));
  });
});

describe('Marshalls HTTP endpoints', () => {
  let server, port;
  beforeAll(done => {
    const app = express(); app.use(express.json()); app.use(router);
    server = app.listen(0, '127.0.0.1', () => { port = server.address().port; done(); });
  });
  afterAll(done => { server.close(done); });
  function request(method, url, body) {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: url, method, headers: { 'Content-Type': 'application/json' } }, res => {
        let data = ''; res.on('data', c => { data += c; }); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(data) }));
      });
      req.on('error', reject); req.end(body === undefined ? undefined : JSON.stringify(body));
    });
  }
  test('catalog exposes only public product data', async () => {
    const res = await request('GET', '/api/ea2d0dbc/catalog');
    expect(res.status).toBe(200); expect(res.body.products).toHaveLength(24);
    expect(res.body.products[0].shippingClass).toBeUndefined();
  });
  test('checkout returns 500 for the planted bug, 200 for healthy orders, 400 for validation', async () => {
    const failure = await request('POST', '/api/ea2d0dbc/checkout', { items: [gift] });
    expect(failure).toMatchObject({ status: 500, body: { success: false, code: 'CHECKOUT_FAILED', errorClass: 'TypeError' } });
    const success = await request('POST', '/api/ea2d0dbc/checkout', { items: [standard] });
    expect(success).toMatchObject({ status: 200, body: { success: true, total: 41.85 } });
    const invalid = await request('POST', '/api/ea2d0dbc/checkout', { items: [{ ...standard, qty: 0 }] });
    expect(invalid).toMatchObject({ status: 400, body: { code: 'INVALID_QUANTITY' } });
  });
});
