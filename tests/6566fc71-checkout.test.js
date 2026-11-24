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
const svc = require('../app/services/verticals/6566fc71');
const router = require('../app/routes/verticals/6566fc71');
const { getCustomerConfig, listAliases } = require('../config/customers');

const ASSETS = path.join(__dirname, '../app/public/verticals/6566fc71-assets');
const order = ({ quantity = 1, fulfillment = { method: 'tienda', storeId: 'santa-fe' }, cardId = 'banamex-credito-4821', installments = 12 } = {}) => ({
  items: [{ sku: '100278405', quantity }], fulfillment, payment: { cardId, installments },
});
beforeEach(() => jest.clearAllMocks());

describe('Office Depot México registration and assets', () => {
  test('registers the slug and aliases without operator impersonation', () => {
    expect(getCustomerConfig(svc.CUSTOMER)).toMatchObject({ label: 'Office Depot México — Checkout (Grupo Gigante)', triggerMode: 'api', githubOrg: 'COG-GTM' });
    expect(listAliases().officedepot).toBe('6566fc71');
    expect(listAliases()['office-depot-mx']).toBe('6566fc71');
    const config = require('../config/customers/6566fc71');
    expect(config.devinUserId).toBeUndefined(); expect(config.devinOrgId).toBeUndefined();
    const js = fs.readFileSync(path.join(ASSETS, 'checkout.js'), 'utf8');
    for (const key of ['devinUserId', 'devinOrgId', 'devinEmail']) expect(js).toContain(`identity('${key}')`);
    expect(js).toContain("fetch('/api/6566fc71/checkout'");
  });

  test('page, styles, fonts and product images are served locally', () => {
    const html = fs.readFileSync(path.join(__dirname, '../app/public/verticals/6566fc71.html'), 'utf8');
    expect(html).toContain('/verticals/6566fc71-assets/checkout.js');
    expect(html).not.toMatch(/https?:\/\/[^"']*officedepot\.com\.mx[^"']*\.(js|css|jpg|svg|woff2)/);
    for (const image of svc.PRODUCTS['100278405'].images) expect(fs.statSync(path.join(__dirname, '../app/public', image)).size).toBeGreaterThan(1000);
    for (const asset of ['logo.svg', 'checkout.css', 'Montserrat-Regular.woff2', 'Montserrat-Bold.woff2']) expect(fs.statSync(path.join(ASSETS, asset)).size).toBeGreaterThan(100);
  });
});

describe('server-authoritative checkout', () => {
  test.each([
    ['banamex-credito-4821', 1, 669900], ['banamex-credito-4821', 3, 223300], ['bbva-credito-7730', 6, 111650],
    ['bbva-credito-7730', 9, 74433], ['banamex-credito-4821', 12, 55825], ['santander-debito-1094', 1, 669900],
  ])('%s with %i installment(s) succeeds', async (cardId, installments, monthly) => {
    const result = await svc.checkout({ order: order({ cardId, installments }) });
    expect(result).toMatchObject({ success: true, currency: 'MXN', subtotalCents: 669900, shippingCents: 0, totalCents: 669900, installments, monthlyPaymentCents: monthly, walletPoints: 66 });
    expect(result.orderId).toMatch(/^OD\d{9}$/);
    expect(createSessionAndAlert).not.toHaveBeenCalled(); expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('home delivery, quantity and client-supplied prices', async () => {
    const result = await svc.checkout({ order: { ...order({ quantity: 2, installments: 1, fulfillment: { method: 'domicilio', postalCode: '06600' } }), totalCents: 1 } });
    expect(result).toMatchObject({ subtotalCents: 1339800, shippingCents: 0, totalCents: 1339800 });
    expect(result.fulfillment).toMatchObject({ method: 'domicilio', postalCode: '06600' });
  });

  test('quoteOrder charges home shipping below the free threshold only', () => {
    const cheap = { ...svc.PRODUCTS['100278405'], priceCents: 50000 };
    expect(svc.quoteOrder([{ product: cheap, quantity: 1 }], { method: 'domicilio' })).toMatchObject({ shippingCents: 9900, totalCents: 59900 });
    expect(svc.quoteOrder([{ product: cheap, quantity: 1 }], { method: 'tienda' })).toMatchObject({ shippingCents: 0, totalCents: 50000 });
  });

  test.each([
    null, [], {}, { items: [] }, order({ quantity: 0 }), order({ quantity: 6 }), order({ quantity: 1.5 }), order({ quantity: '1' }),
    { ...order(), items: [{ sku: '__proto__', quantity: 1 }] }, { ...order(), items: [{ sku: '999', quantity: 1 }] },
    order({ fulfillment: { method: 'tienda', storeId: 'toString' } }), order({ fulfillment: { method: 'domicilio', postalCode: '123' } }),
    order({ fulfillment: { method: 'drone' } }), order({ cardId: 'constructor' }), order({ installments: 0 }), order({ installments: 24 }),
    order({ installments: '12' }), order({ cardId: 'santander-debito-1094', installments: 18 }),
  ])('rejects invalid order before alerting: %j', async input => {
    await expect(svc.checkout({ order: input })).rejects.toMatchObject({ name: 'ValidationError', status: 400, code: 'INVALID_CHECKOUT' });
    expect(createSessionAndAlert).not.toHaveBeenCalled(); expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});

describe('planted 18 MSI failure and incident flow', () => {
  test('18 MSI produces one Sentry capture and an instant alert with an actionable prompt', async () => {
    await expect(svc.checkout({ order: order({ installments: 18 }), devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com' })).rejects.toMatchObject({
      name: 'TypeError', message: "Cannot read properties of undefined (reading 'sobretasaBps')", status: 500, code: 'CHECKOUT_FAILED',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(TypeError), expect.objectContaining({ tags: expect.objectContaining({ customer: svc.CUSTOMER, alert_path: 'instant' }) }));
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert).toMatchObject({ customer: svc.CUSTOMER, service: svc.SERVICE, culprit: svc.CULPRIT, devinUserId: 'user-test', devinOrgId: 'org-test', devinEmail: 'demo@example.com', extra: { installments: 18, cardId: 'banamex-credito-4821', totalCents: 669900 } });
    expect(isInstantPathEvent(alert)).toBe(true);
    expect(buildPrompt(alert)).toContain('6566fc71');
    expect(alert.promptAppendix).toContain('1950 bps');
    expect(alert.promptAppendix).toContain('do not merge or deploy');
  });

  test('alert delivery failures never replace the original checkout error', async () => {
    createSessionAndAlert.mockRejectedValueOnce(new Error('notification unavailable'));
    await expect(svc.checkout({ order: order({ installments: 18 }) })).rejects.toBeInstanceOf(TypeError);
    await new Promise(resolve => setImmediate(resolve));
    expect(require('../app/telemetry/logger').error).toHaveBeenCalledWith('Failed to create Devin session for Office Depot México checkout', expect.objectContaining({ error: 'notification unavailable' }));
  });
});

describe('HTTP contract', () => {
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
  test('catalog exposes products, stores and cards but not acquirer fees', async () => {
    const res = await request('GET', '/api/6566fc71/catalog');
    expect(res.status).toBe(200);
    expect(res.body.products[0]).toMatchObject({ sku: '100278405', priceCents: 669900, msiPlans: [3, 6, 9, 12, 18] });
    expect(res.body.stores).toHaveLength(5); expect(res.body.cards).toHaveLength(3);
    expect(JSON.stringify(res.body)).not.toContain('sobretasa');
  });
  test('checkout returns 500 on the planted bug, 200 when healthy, 400 on invalid input', async () => {
    expect(await request('POST', '/api/6566fc71/checkout', { order: order({ installments: 18 }), devinUserId: 'route-user', devinOrgId: 'route-org' })).toMatchObject({ status: 500, body: { success: false, code: 'CHECKOUT_FAILED', errorClass: 'TypeError' } });
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ devinUserId: 'route-user', devinOrgId: 'route-org' }));
    expect(await request('POST', '/api/6566fc71/checkout', { order: order() })).toMatchObject({ status: 200, body: { success: true, totalCents: 669900 } });
    expect(await request('POST', '/api/6566fc71/checkout', { order: order({ quantity: 0 }) })).toMatchObject({ status: 400, body: { code: 'INVALID_CHECKOUT' } });
    expect(await request('POST', '/api/6566fc71/checkout')).toMatchObject({ status: 400 });
  });
});
