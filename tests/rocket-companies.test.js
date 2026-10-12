const express = require('express');

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const router = require('../app/routes/verticals/4e90bb44');
const service = require('../app/services/verticals/4e90bb44');

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

function apply(body, headers = {}) {
  return fetch(`${baseUrl}/api/rocket-companies/savings/apply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  }).then(async (res) => ({ status: res.status, body: await res.json() }));
}

describe('Rocket Companies — Rocket Mortgage & Redfin savings', () => {
  test('a Mr. Cooper-boarded buy-and-sell client hits the planted TypeError and raises an alert', async () => {
    const res = await apply({ clientId: 'RKT-7731' });

    expect(res.status).toBe(500);
    expect(res.body.errorClass).toBe('TypeError');
    expect(res.body.error).toMatch(/reading 'loanNumber'/);
    expect(res.body.code).toBe('SAVINGS_APPLY_FAILED');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('4e90bb44');
    expect(alert.service).toBe('customer-rocket-companies-redfin-savings');
    expect(alert.culprit).toMatch(/currentLoanForSale/);
    expect(alert.promptAppendix).toMatch(/\/rocket-companies\?repro=1/);
    expect(alert.extra.priorServicer).toBe('Mr. Cooper');
  });

  test('reproduction mode fails identically without Sentry, Slack or a Devin session', async () => {
    const res = await apply({ clientId: 'RKT-7731' }, { 'x-synthetic': '1' });

    expect(res.status).toBe(500);
    expect(res.body.error).toMatch(/reading 'loanNumber'/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('reproduction header is ignored in production', async () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      await apply({ clientId: 'RKT-7731' }, { 'x-synthetic': '1' });
    } finally {
      process.env.NODE_ENV = previous;
    }
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
  });

  test('a buy-and-sell client whose loan started at Rocket gets the full match', async () => {
    const res = await apply({ clientId: 'RKT-4410' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.tier.id).toBe('buy-sell');
    expect(res.body.loanAmount).toBe(640000);
    expect(res.body.lenderCredit).toBe(4800);
    expect(res.body.commissionDiscount).toBe(4800);
    expect(res.body.totalSavings).toBe(9600);
    expect(res.body.saleLink.currentLoan.loanNumber).toBe('3307194418');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a buy-only client gets the lender credit without a sale link', async () => {
    const res = await apply({ clientId: 'RKT-2291' });

    expect(res.status).toBe(200);
    expect(res.body.tier.id).toBe('buy');
    expect(res.body.lenderCredit).toBe(2850);
    expect(res.body.commissionDiscount).toBe(0);
    expect(res.body.totalSavings).toBe(2850);
    expect(res.body.saleLink).toBeNull();
  });

  test('an unknown client is a handled 400 with no alert', async () => {
    const res = await apply({ clientId: 'RKT-0000' });

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('UNKNOWN_CLIENT');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('offer endpoint lists the clients and tiers with Dana pre-selected', async () => {
    const res = await fetch(`${baseUrl}/api/rocket-companies/offer`).then((r) => r.json());

    expect(res.defaultClientId).toBe('RKT-7731');
    expect(res.clients.map((c) => c.clientId)).toEqual(['RKT-7731', 'RKT-4410', 'RKT-2291']);
    expect(res.clients[0]).not.toHaveProperty('servicingTransfer');
    expect(res.tiers).toEqual([
      { id: 'buy', label: 'Buy, finance & save', maxSavings: 6000 },
      { id: 'buy-sell', label: 'Buy, sell & save most', maxSavings: 12000 },
    ]);
  });

  test('lender credit is capped at $6,000 and the buy-and-sell match at $12,000', () => {
    const client = {
      ...service.CLIENTS['RKT-4410'],
      purchase: { address: 'x', price: 1000000, downPayment: 200000 },
    };
    const savings = service.priceSavings(client);
    expect(savings.lenderCredit).toBe(6000);
    expect(savings.totalSavings).toBe(12000);
  });
});
