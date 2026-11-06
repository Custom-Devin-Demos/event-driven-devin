/* global describe, expect, test, jest, afterEach, setImmediate */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const routes = require('../app/routes/verticals/947c7934');
const {
  ACCOUNT,
  BALANCES,
  TRANSACTIONS,
  PAYEES,
  BATCHES,
  SCREENING_POLICY,
  LATENCY_SLO,
} = require('../app/services/verticals/947c7934');

const ORIGINAL_MIN_LATENCY = SCREENING_POLICY.perPayeeMinMs;
const ORIGINAL_MAX_LATENCY = SCREENING_POLICY.perPayeeMaxMs;
const ORIGINAL_BUDGET = LATENCY_SLO.budgetMs;

function request(method, path, body) {
  const app = express();
  app.use(express.json());
  app.use(routes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = body === undefined ? '' : JSON.stringify(body);
      const headers = { 'Content-Length': Buffer.byteLength(payload) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const req = http.request(
        { host: '127.0.0.1', port, path, method, headers },
        (res) => {
          let raw = '';
          res.on('data', (chunk) => { raw += chunk; });
          res.on('end', () => {
            server.close(() => resolve({ status: res.statusCode, body: JSON.parse(raw) }));
          });
        },
      );
      req.on('error', (error) => server.close(() => reject(error)));
      req.end(payload);
    });
  });
}

function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

afterEach(() => {
  SCREENING_POLICY.perPayeeMinMs = ORIGINAL_MIN_LATENCY;
  SCREENING_POLICY.perPayeeMaxMs = ORIGINAL_MAX_LATENCY;
  LATENCY_SLO.budgetMs = ORIGINAL_BUDGET;
  createSessionAndAlert.mockClear();
});

describe('Rho Move Funds', () => {
  test('returns account, transactions, payees and the February Bill Pay batch', async () => {
    const { status, body } = await request('GET', '/api/947c7934/account');

    expect(status).toBe(200);
    expect(body.account).toEqual(ACCOUNT);
    expect(body.balances).toEqual(BALANCES);
    expect(body.transactions).toEqual(TRANSACTIONS);
    expect(body.transactions[0]).toMatchObject({
      id: expect.any(String),
      createdDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      amountCents: expect.any(Number),
      sender: { name: expect.any(String), accountType: expect.any(String), mask: expect.any(String) },
      recipient: { name: expect.any(String), accountType: expect.any(String) },
      type: expect.any(String),
      status: expect.any(String),
    });
    expect(body.payees).toEqual(PAYEES);
    expect(body.batches).toHaveLength(1);
    expect(body.batches[0]).toMatchObject({
      id: 'bp-0206',
      name: 'February vendor run',
      vendorCount: 14,
      totalCents: 14854121,
    });
    expect(body.batches[0].vendors).toHaveLength(14);
    expect(body.batches[0].vendors.reduce((sum, vendor) => sum + vendor.amountCents, 0)).toBe(14854121);
  });

  test('screens the default Bill Pay batch in order and returns its payment payload', async () => {
    SCREENING_POLICY.perPayeeMinMs = 1;
    SCREENING_POLICY.perPayeeMaxMs = 2;

    const { status, body } = await request('POST', '/api/947c7934/payments', {
      fromAccount: 'op-1234',
      paymentType: 'bill_pay_batch',
      batchId: 'bp-0206',
    });

    expect(status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      payment: {
        type: 'bill_pay_batch',
        typeLabel: 'Bill Pay',
        status: 'Pending',
        amountCents: 14854121,
        from: ACCOUNT,
        recipient: '14 vendors',
        memo: 'February vendor run',
      },
      screening: { checked: 14, cleared: 14, flagged: 0 },
      balances: { availableAfterCents: 477836297 },
      latencyBudgetMs: 3000,
    });
    expect(body.requestId).toMatch(/^RHO-[0-9A-F]{8}$/);
    expect(body.payment.id).toMatch(/^PAY-[0-9A-F]{8}$/);
    expect(body.payment.createdAt).toEqual(expect.any(String));
    expect(body.screening.results.map((result) => result.payeeId))
      .toEqual(BATCHES[0].vendors.map((vendor) => vendor.id));
    expect(body.screening.results.map((result) => result.name))
      .toEqual(BATCHES[0].vendors.map((vendor) => vendor.name));
    expect(body.screening.results.every((result) => result.status === 'cleared')).toBe(true);
    expect(body.durationMs).toBeGreaterThanOrEqual(0);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['wire_us', 'py-2214', 'Wire-US'],
    ['wire_intl', 'py-4402', 'Wire-INTL'],
    ['ach_us', 'py-1101', 'ACH-US'],
    ['book_transfer', 'pay-5678', 'Book Transfer'],
  ])('processes a single-payee %s payment with one screening check', async (paymentType, payeeId, typeLabel) => {
    SCREENING_POLICY.perPayeeMinMs = 1;
    SCREENING_POLICY.perPayeeMaxMs = 3;

    const { status, body } = await request('POST', '/api/947c7934/payments', {
      fromAccount: 'op-1234',
      paymentType,
      payeeId,
      amountCents: 12500,
    });
    await tick();

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.payment).toMatchObject({
      type: paymentType,
      typeLabel,
      amountCents: 12500,
      status: 'Pending',
    });
    expect(body.screening).toMatchObject({ checked: 1, cleared: 1, flagged: 0 });
    expect(body.screening.results[0]).toMatchObject({ payeeId, status: 'cleared' });
    expect(body.balances.availableAfterCents).toBe(BALANCES.availableCents - 12500);
    expect(body.durationMs).toBeLessThan(1000);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['unknown source account', { fromAccount: 'missing', paymentType: 'wire_us', payeeId: 'py-2214', amountCents: 1000 }, 'UNKNOWN_FROM_ACCOUNT'],
    ['unknown payment type', { fromAccount: 'op-1234', paymentType: 'cash', payeeId: 'py-2214', amountCents: 1000 }, 'UNKNOWN_PAYMENT_TYPE'],
    ['unknown batch', { fromAccount: 'op-1234', paymentType: 'bill_pay_batch', batchId: 'bp-missing' }, 'UNKNOWN_BATCH'],
    ['missing single-payee id', { fromAccount: 'op-1234', paymentType: 'wire_us', amountCents: 1000 }, 'PAYEE_REQUIRED'],
    ['unknown single-payee id', { fromAccount: 'op-1234', paymentType: 'wire_us', payeeId: 'py-missing', amountCents: 1000 }, 'UNKNOWN_PAYEE'],
    ['zero single-payee amount', { fromAccount: 'op-1234', paymentType: 'wire_us', payeeId: 'py-2214', amountCents: 0 }, 'INVALID_AMOUNT'],
    ['fractional single-payee amount', { fromAccount: 'op-1234', paymentType: 'wire_us', payeeId: 'py-2214', amountCents: 10.5 }, 'INVALID_AMOUNT'],
    ['amount above available balance', { fromAccount: 'op-1234', paymentType: 'wire_us', payeeId: 'py-2214', amountCents: 500000000 }, 'INSUFFICIENT_FUNDS'],
    ['international wire to a domestic payee', { fromAccount: 'op-1234', paymentType: 'wire_intl', payeeId: 'py-2214', amountCents: 1000 }, 'RAIL_MISMATCH'],
    ['domestic wire to an international payee', { fromAccount: 'op-1234', paymentType: 'wire_us', payeeId: 'py-4402', amountCents: 1000 }, 'RAIL_MISMATCH'],
    ['ACH to an international payee', { fromAccount: 'op-1234', paymentType: 'ach_us', payeeId: 'py-4402', amountCents: 1000 }, 'RAIL_MISMATCH'],
    ['book transfer to an external payee', { fromAccount: 'op-1234', paymentType: 'book_transfer', payeeId: 'py-2214', amountCents: 1000 }, 'INVALID_TRANSFER_TARGET'],
  ])('returns a structured 400 for %s', async (_description, body, code) => {
    const { status, body: response } = await request('POST', '/api/947c7934/payments', body);

    expect(status).toBe(400);
    expect(response).toMatchObject({
      success: false,
      errorClass: 'ValidationError',
      code,
      requestId: expect.stringMatching(/^RHO-[0-9A-F]{8}$/),
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('returns success and schedules a Devin alert when screening exceeds the latency budget', async () => {
    SCREENING_POLICY.perPayeeMinMs = 1;
    SCREENING_POLICY.perPayeeMaxMs = 2;
    LATENCY_SLO.budgetMs = 0;

    const { status, body } = await request('POST', '/api/947c7934/payments', {
      fromAccount: 'op-1234',
      paymentType: 'bill_pay_batch',
      batchId: 'bp-0206',
      devinUserId: 'clerk-user_demo',
      devinOrgId: 'org_demo',
      devinEmail: 'jordan.lee@example.com',
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.durationMs).toBeGreaterThan(LATENCY_SLO.budgetMs);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.errorType).toBe('LatencyBudgetExceeded');
    expect(alert.issueTitle).toContain('POST /api/947c7934/payments took');
    expect(alert.customer).toBe('947c7934');
    expect(alert.service).toBe('customer-947c7934-move-funds');
    expect(alert.culprit).toBe('app/services/verticals/947c7934.js — screenBatchPayees');
    expect(alert.verticalLabel).toBe('Rho Move Funds');
    expect(alert.level).toBe('warning');
    expect(alert.devinUserId).toBe('clerk-user_demo');
    expect(alert.devinOrgId).toBe('org_demo');
    expect(alert.devinEmail).toBe('jordan.lee@example.com');
    expect(alert.promptAppendix).toContain('screenBatchPayees');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/947c7934/payments' },
      { key: 'service', value: 'customer-947c7934-move-funds' },
      { key: 'payment_type', value: 'bill_pay_batch' },
      { key: 'duration_ms', value: String(body.durationMs) },
    ]));
    expect(alert.extra).toEqual(expect.objectContaining({
      requestId: body.requestId,
      durationMs: body.durationMs,
      budgetMs: 0,
      payeesChecked: 14,
      datadogMetric: 'payment.latency',
    }));
  });
});
