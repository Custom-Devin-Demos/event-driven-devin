jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const router = require('../app/routes/verticals/ad6a0c70');
const service = require('../app/services/verticals/ad6a0c70');
const psp = require('../app/services/verticals/ad6a0c70-meridian-psp');
const sharedPsp = require('../app/services/verticals/f63013c0-meridian-psp');
const { CUSTOMERS, listAliases } = require('../config/customers');

const JULIEN_ORDER = {
  customerId: 'cus_julien_fr',
  cartId: 'pan_julien_fr',
  addressId: 'addr_julien_lyon',
  lines: [
    { sku: 'LP-TB-1126485', qty: 1 },
    { sku: 'LP-CO-2126908', qty: 1, giftBox: true },
  ],
  paymentMethod: 'card',
  cardToken: 'tok_julien_fr_visa_4242',
};

let server;
let base;

const post = (p, body, headers = {}) => fetch(`${base}${p}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body || {}),
});

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  base = `http://127.0.0.1:${server.address().port}`;
  process.env.LAPOSTE_MERIDIAN_PAY_BASE_URL = `${base}/api/ad6a0c70/psp`;
});

afterAll((done) => {
  delete process.env.LAPOSTE_MERIDIAN_PAY_BASE_URL;
  server.close(done);
});

beforeEach(() => {
  service.reset();
  jest.clearAllMocks();
});

describe('La Poste standalone checkout (ad6a0c70)', () => {
  test('is registered at /laposte with its own customer config', () => {
    expect(listAliases().laposte).toBe('ad6a0c70');
    expect(CUSTOMERS['ad6a0c70'].label).toMatch(/^La Poste/);
  });

  test('catalog serves the La Poste shop catalog in EUR for a Lyon customer', async () => {
    const d = await (await fetch(`${base}/api/ad6a0c70/catalog`)).json();
    expect(d.currency).toBe('EUR');
    expect(d.customer.address).toMatchObject({ city: 'Lyon', zip: '69002', country: 'France' });
    expect(d.products.every((p) => p.sku.startsWith('LP-'))).toBe(true);
    expect(d.pspApiVersion).toBe('2026-10');
  });

  test('card checkout succeeds in EUR as LA POSTE on API 2025-06', async () => {
    psp.setVersion('2025-06');
    const res = await post('/api/ad6a0c70/checkout', JULIEN_ORDER);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.order).toMatchObject({
      status: 'confirmed', total: 26.74, currency: 'EUR', shipTo: '24 rue de la République, 69002 Lyon, France',
    });
    const auth = psp.listAuthorizations({ cardToken: 'tok_julien_fr_visa_4242' })[0];
    expect(auth).toMatchObject({ amount: 26.74, currency: 'EUR', descriptor: 'LA POSTE' });
  });

  test('card checkout is broken by default: 502 PAYMENT_FAILED after the card is authorised', async () => {
    const res = await post('/api/ad6a0c70/checkout', JULIEN_ORDER);
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body).toMatchObject({ success: false, code: 'PAYMENT_FAILED' });
    expect(psp.listAuthorizations()).toHaveLength(1);
    expect(service.getMetrics().chargedWithoutOrder).toBe(1);
  });

  test('the failure fires one La Poste alert using the shared storefront credentials', async () => {
    await post('/api/ad6a0c70/checkout', JULIEN_ORDER);
    await post('/api/ad6a0c70/checkout', JULIEN_ORDER);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.issueTitle).toBe('Error: Missing payment id in PSP response');
    expect(alert.verticalLabel).toBe('La Poste — Boutique Checkout');
    expect(alert.customer).toBe('f63013c0');
    expect(alert.service).toBe('laposte-checkout-service');
    expect(alert.extra.promptContext).toContain('laposte.fr');
    expect(alert.extra.promptAppendix).toContain('docs/ad6a0c70/RUNBOOK.md');
    expect(alert.extra.responseKeys).toContain('pspReference');
  });

  test('x-demo-alerts: off keeps the failure but skips the alert', async () => {
    const res = await post('/api/ad6a0c70/checkout', JULIEN_ORDER, { 'x-demo-alerts': 'off' });
    expect(res.status).toBe(502);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('paypal confirms even when the PSP is on API 2026-10', async () => {
    const res = await post('/api/ad6a0c70/checkout', { ...JULIEN_ORDER, paymentMethod: 'paypal', cardToken: undefined });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.order).toMatchObject({ status: 'confirmed', paymentMethod: 'paypal' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['empty basket', { ...JULIEN_ORDER, lines: [] }],
    ['unknown sku', { ...JULIEN_ORDER, lines: [{ sku: 'RL-KN-001', qty: 1 }] }],
    ['qty out of range', { ...JULIEN_ORDER, lines: [{ sku: 'LP-TB-1126485', qty: 9 }] }],
    ['unknown card token', { ...JULIEN_ORDER, cardToken: 'tok_other' }],
    ['gift wrap on ineligible sku', { ...JULIEN_ORDER, lines: [{ sku: 'LP-TB-1126020', qty: 1, giftBox: true }] }],
  ])('validation %s returns 400 without alerting', async (_name, payload) => {
    const res = await post('/api/ad6a0c70/checkout', payload);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('PSP simulator is separate from the shared storefront PSP', async () => {
    sharedPsp.reset();
    await post('/api/ad6a0c70/checkout', JULIEN_ORDER);
    expect(psp.listAuthorizations()).toHaveLength(1);
    expect(sharedPsp.listAuthorizations()).toHaveLength(0);
  });
});
