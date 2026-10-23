const express = require('express');

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const router = require('../app/routes/verticals/4dd0a997');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const TV = { sku: '6671348', quantity: 1 };

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(router);
  server = app.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.closeAllConnections();
  server.close(done);
});

beforeEach(() => {
  createSessionAndAlert.mockClear();
  Sentry.captureException.mockClear();
});

function checkout(body, headers = {}) {
  return fetch(`${baseUrl}/api/best-buy/checkout`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

describe('Best Buy — Black Friday checkout', () => {
  test('a legacy Totaltech member hits the planted TypeError and raises an alert', async () => {
    const res = await checkout({ customerId: 'BBY-30418', items: [TV] });

    expect(res.status).toBe(500);
    expect(res.body.errorClass).toBe('TypeError');
    expect(res.body.error).toMatch(/reading 'creditCard'/);
    expect(res.body.code).toBe('CHECKOUT_FAILED');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('4dd0a997');
    expect(alert.service).toBe('customer-best-buy-checkout');
    expect(alert.culprit).toMatch(/memberRewardRate/);
    expect(alert.promptAppendix).toMatch(/\/best-buy\?repro=1/);
    expect(alert.extra.membershipProgram).toBe('totaltech');
  });

  test('reproduction mode fails identically without Sentry, Slack or a Devin session', async () => {
    const res = await checkout({ customerId: 'BBY-30418', items: [TV] }, { 'x-synthetic': '1' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/reading 'creditCard'/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('reproduction header is ignored in production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await checkout({ customerId: 'BBY-30418', items: [TV] }, { 'x-synthetic': '1' });
    } finally {
      process.env.NODE_ENV = previous;
    }
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('a Total member who joined after the rename earns 6% with the My Best Buy card', async () => {
    const res = await checkout({ customerId: 'BBY-58120', items: [{ ...TV, quantity: 2 }] });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.orderNumber).toMatch(/^BBY01-8064\d{8}$/);
    expect(res.body.subtotal).toBe(2199.98);
    expect(res.body.savings).toBe(1800);
    expect(res.body.tax).toBe(173.25);
    expect(res.body.total).toBe(2373.23);
    expect(res.body.rewards).toEqual({ program: 'My Best Buy Total', rate: 0.06, amount: 132 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a Plus member paying with another card earns 1%', async () => {
    const res = await checkout({ customerId: 'BBY-77302', items: [TV] });

    expect(res.status).toBe(200);
    expect(res.body.rewards).toEqual({ program: 'My Best Buy Plus', rate: 0.01, amount: 11 });
  });

  test('a guest checks out without rewards', async () => {
    const res = await checkout({ customerId: 'guest', items: [TV] });

    expect(res.status).toBe(200);
    expect(res.body.rewards).toEqual({ program: null, rate: 0, amount: 0 });
  });

  test.each([
    [{ customerId: 'BBY-00000', items: [TV] }, 'UNKNOWN_CUSTOMER'],
    [{ customerId: 'guest', items: [] }, 'EMPTY_CART'],
    [{ customerId: 'guest', items: [{ sku: '123', quantity: 1 }] }, 'UNKNOWN_SKU'],
    [{ customerId: 'guest', items: [{ ...TV, quantity: 4 }] }, 'LIMIT_EXCEEDED'],
  ])('invalid checkout %# is a handled 400 with no alert', async (body, code) => {
    const res = await checkout(body);

    expect(res.status).toBe(400);
    expect(res.body.code).toBe(code);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('storefront endpoint returns the doorbuster and the shoppers with Jordan pre-selected', async () => {
    const res = await fetch(`${baseUrl}/api/best-buy/storefront`).then((r) => r.json());

    expect(res.defaultCustomerId).toBe('BBY-30418');
    expect(res.product).toMatchObject({ sku: '6671348', price: 1099.99, compValue: 1999.99 });
    expect(res.customers.map((c) => c.customerId)).toEqual(['BBY-30418', 'BBY-58120', 'BBY-77302', 'guest']);
    expect(res.customers[0].membership).toEqual({ displayName: 'My Best Buy Total', memberSince: '2022-03-14' });
    expect(res.customers[0].membership).not.toHaveProperty('program');
  });
});

test('Sentry issue webhook skips Best Buy events already alerted by the instant path', () => {
  expect(isInstantPathEvent({
    culprit: 'app/services/verticals/4dd0a997 in memberRewardRate',
    tags: [],
  })).toBe(true);
});
