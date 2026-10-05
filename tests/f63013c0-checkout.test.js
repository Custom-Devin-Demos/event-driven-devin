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
const router = require('../app/routes/verticals/f63013c0');
const service = require('../app/services/verticals/f63013c0');
const psp = require('../app/services/verticals/f63013c0-meridian-psp');
const { planReconciliation } = require('../scripts/f63013c0-reconcile-authorizations');

const CLAIRE_ORDER = {
  customerId: 'cus_claire',
  cartId: 'bsk_claire',
  addressId: 'addr_claire_home',
  lines: [
    { sku: 'RL-KN-001', qty: 1 },
    { sku: 'RL-AC-014', qty: 1, giftBox: true },
  ],
  paymentMethod: 'card',
  cardToken: 'tok_claire_visa_4242',
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
  process.env.MERIDIAN_PAY_BASE_URL = `${base}/api/f63013c0/psp`;
});

afterAll((done) => {
  delete process.env.MERIDIAN_PAY_BASE_URL;
  server.close(done);
});

beforeEach(() => {
  service.reset();
  jest.clearAllMocks();
});

describe('Ralph Lauren checkout (f63013c0)', () => {
  test('Claire\'s default basket checks out for $568 on API 2025-06', async () => {
    const res = await post('/api/f63013c0/checkout', CLAIRE_ORDER);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.order.status).toBe('confirmed');
    expect(body.order.total).toBe(568);
    expect(body.order.paymentMethod).toBe('card');
    expect(body.order.lines).toHaveLength(2);
  });

  test('paypal confirms even when the PSP is on API 2026-10', async () => {
    psp.setVersion('2026-10');
    const res = await post('/api/f63013c0/checkout', { ...CLAIRE_ORDER, paymentMethod: 'paypal', cardToken: undefined });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.order.status).toBe('confirmed');
    expect(body.order.paymentMethod).toBe('paypal');
  });

  test.each([
    ['empty basket', { ...CLAIRE_ORDER, lines: [] }],
    ['unknown sku', { ...CLAIRE_ORDER, lines: [{ sku: 'RL-XX-999', qty: 1 }] }],
    ['qty out of range', { ...CLAIRE_ORDER, lines: [{ sku: 'RL-KN-001', qty: 9 }] }],
    ['unknown card token', { ...CLAIRE_ORDER, cardToken: 'tok_not_claire' }],
    ['gift box on ineligible sku', { ...CLAIRE_ORDER, lines: [{ sku: 'RL-SH-102', qty: 1, giftBox: true }] }],
  ])('validation %s returns 400 without alerting', async (_name, payload) => {
    const res = await post('/api/f63013c0/checkout', payload);
    const body = await res.json();
    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.code).toBe('VALIDATION_ERROR');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('PSP simulator honours Idempotency-Key', async () => {
    const payment = { amount: 100, currency: 'USD', cardToken: 'tok_x', reference: 'ord_1' };
    const first = await (await post('/api/f63013c0/psp/v1/payments', payment, { 'Idempotency-Key': 'key-1' })).json();
    const second = await (await post('/api/f63013c0/psp/v1/payments', payment, { 'Idempotency-Key': 'key-1' })).json();
    const firstId = first.paymentId || first.pspReference;
    const secondId = second.paymentId || second.pspReference;
    expect(secondId).toBe(firstId);
    const { authorizations } = await (await fetch(`${base}/api/f63013c0/psp/v1/authorizations`)).json();
    expect(authorizations).toHaveLength(1);
  });

  test('metrics exposes the dashboard shape', async () => {
    await post('/api/f63013c0/checkout', CLAIRE_ORDER);
    const m = await (await fetch(`${base}/api/f63013c0/metrics`)).json();
    expect(m.window).toBe('60s');
    expect(m.orderSuccessRate).toBe(1);
    expect(m.ordersPerMinute).toBe(1);
    expect(m).toMatchObject({
      chargedWithoutOrder: 0,
      duplicateAuthorizations: 0,
      customersAffected: 0,
      status: 'HEALTHY',
      pspApiVersion: '2025-06',
      trafficRunning: false,
    });
    expect(m.attempts).toBe(1);
    expect(Array.isArray(m.history)).toBe(true);
  });

  test('storefront, bank and ops pages are served; bare slug 404s', async () => {
    for (const p of ['/f63013c0/rb/retail', '/f63013c0/rb/retail/bank', '/f63013c0/rb/retail/ops']) {
      const res = await fetch(`${base}${p}`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toMatch(/text\/html/);
    }
    expect((await fetch(`${base}/f63013c0`)).status).toBe(404);
  });
});

describe('reconciliation planning', () => {
  const auth = (id, reference, status = 'AUTHORISED') => ({
    id, reference, status, createdAt: '2026-10-05T14:00:00Z', voidedAt: status === 'VOIDED' ? '2026-10-05T15:00:00Z' : null,
  });

  test('pending order with two authorizations completes with the first and voids the rest', () => {
    const auths = [auth('psp_1', 'ord_a'), auth('psp_2', 'ord_a')];
    const orders = { ord_a: { id: 'ord_a', status: 'pending' } };
    const plan = planReconciliation(auths, orders);
    expect(plan.complete).toEqual([{ orderId: 'ord_a', paymentId: 'psp_1' }]);
    expect(plan.void).toEqual([{ id: 'psp_2', reference: 'ord_a' }]);
  });

  test('paid order keeps the authorization matching its paymentId', () => {
    const auths = [auth('psp_1', 'ord_b'), auth('psp_2', 'ord_b')];
    const orders = { ord_b: { id: 'ord_b', status: 'paid', paymentId: 'psp_2' } };
    const plan = planReconciliation(auths, orders);
    expect(plan.complete).toEqual([]);
    expect(plan.void).toEqual([{ id: 'psp_1', reference: 'ord_b' }]);
  });

  test('voided authorizations are ignored', () => {
    const auths = [auth('psp_1', 'ord_c', 'VOIDED')];
    const orders = { ord_c: { id: 'ord_c', status: 'pending' } };
    const plan = planReconciliation(auths, orders);
    expect(plan.complete).toEqual([]);
    expect(plan.void).toEqual([]);
  });
});
