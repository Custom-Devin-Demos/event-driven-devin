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
const router = require('../app/routes/verticals/2351d2b1');
const service = require('../app/services/verticals/2351d2b1');
const psp = require('../app/services/verticals/2351d2b1-meridian-psp');
const sharedPsp = require('../app/services/verticals/f63013c0-meridian-psp');
const { CUSTOMERS, listAliases } = require('../config/customers');

const CLAIRE_ORDER = {
  customerId: 'cus_claire_fr',
  cartId: 'bsk_claire_fr',
  addressId: 'addr_claire_paris',
  lines: [
    { sku: 'CF-FL-001', qty: 1 },
    { sku: 'CF-PO-014', qty: 1, giftBox: true },
  ],
  paymentMethod: 'card',
  cardToken: 'tok_claire_fr_visa_4242',
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
  process.env.CARREFOUR_MERIDIAN_PAY_BASE_URL = `${base}/api/2351d2b1/psp`;
});

afterAll((done) => {
  delete process.env.CARREFOUR_MERIDIAN_PAY_BASE_URL;
  server.close(done);
});

beforeEach(() => {
  service.reset();
  jest.clearAllMocks();
});

describe('Carrefour standalone checkout (2351d2b1)', () => {
  test('is registered at /carrefour with its own customer config', () => {
    expect(listAliases().carrefour).toBe('2351d2b1');
    expect(CUSTOMERS['2351d2b1'].label).toMatch(/^Carrefour/);
  });

  test('catalog serves the grocery catalog in EUR for a Paris customer', async () => {
    const d = await (await fetch(`${base}/api/2351d2b1/catalog`)).json();
    expect(d.currency).toBe('EUR');
    expect(d.customer.address).toMatchObject({ city: 'Paris', zip: '75004', country: 'France' });
    expect(d.products.every((p) => p.sku.startsWith('CF-'))).toBe(true);
    expect(d.pspApiVersion).toBe('2026-10');
  });

  test('card checkout succeeds in EUR as CARREFOUR on API 2025-06', async () => {
    psp.setVersion('2025-06');
    const res = await post('/api/2351d2b1/checkout', CLAIRE_ORDER);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.order).toMatchObject({
      status: 'confirmed', total: 11.98, currency: 'EUR', shipTo: '12 rue de Rivoli, 75004 Paris, France',
    });
    const auth = psp.listAuthorizations({ cardToken: 'tok_claire_fr_visa_4242' })[0];
    expect(auth).toMatchObject({ amount: 11.98, currency: 'EUR', descriptor: 'CARREFOUR' });
  });

  test('card checkout is broken by default: 502 PAYMENT_FAILED after the card is authorised', async () => {
    const res = await post('/api/2351d2b1/checkout', CLAIRE_ORDER);
    const body = await res.json();
    expect(res.status).toBe(502);
    expect(body).toMatchObject({ success: false, code: 'PAYMENT_FAILED' });
    expect(psp.listAuthorizations()).toHaveLength(1);
    expect(service.getMetrics().chargedWithoutOrder).toBe(1);
  });

  test('the failure fires one Carrefour alert using the shared storefront credentials', async () => {
    await post('/api/2351d2b1/checkout', CLAIRE_ORDER);
    await post('/api/2351d2b1/checkout', CLAIRE_ORDER);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.issueTitle).toBe('Error: Missing payment id in PSP response');
    expect(alert.verticalLabel).toBe('Carrefour — Courses en ligne Checkout');
    expect(alert.customer).toBe('f63013c0');
    expect(alert.service).toBe('carrefour-checkout-service');
    expect(alert.extra.promptContext).toContain('carrefour.fr');
    expect(alert.extra.promptAppendix).toContain('docs/2351d2b1/RUNBOOK.md');
    expect(alert.extra.responseKeys).toContain('pspReference');
  });

  test('x-demo-alerts: off keeps the failure but skips the alert', async () => {
    const res = await post('/api/2351d2b1/checkout', CLAIRE_ORDER, { 'x-demo-alerts': 'off' });
    expect(res.status).toBe(502);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('paypal confirms even when the PSP is on API 2026-10', async () => {
    const res = await post('/api/2351d2b1/checkout', { ...CLAIRE_ORDER, paymentMethod: 'paypal', cardToken: undefined });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.order).toMatchObject({ status: 'confirmed', paymentMethod: 'paypal' });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['empty basket', { ...CLAIRE_ORDER, lines: [] }],
    ['unknown sku', { ...CLAIRE_ORDER, lines: [{ sku: 'RL-KN-001', qty: 1 }] }],
    ['qty out of range', { ...CLAIRE_ORDER, lines: [{ sku: 'CF-FL-001', qty: 9 }] }],
    ['unknown card token', { ...CLAIRE_ORDER, cardToken: 'tok_other' }],
    ['fresh bag on ineligible sku', { ...CLAIRE_ORDER, lines: [{ sku: 'CF-PA-102', qty: 1, giftBox: true }] }],
  ])('validation %s returns 400 without alerting', async (_name, payload) => {
    const res = await post('/api/2351d2b1/checkout', payload);
    expect(res.status).toBe(400);
    expect((await res.json()).code).toBe('VALIDATION_ERROR');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('PSP simulator is separate from the shared storefront PSP', async () => {
    sharedPsp.reset();
    await post('/api/2351d2b1/checkout', CLAIRE_ORDER);
    expect(psp.listAuthorizations()).toHaveLength(1);
    expect(sharedPsp.listAuthorizations()).toHaveLength(0);
  });
});
