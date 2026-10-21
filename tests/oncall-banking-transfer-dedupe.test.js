/* global jest, afterAll, beforeAll, describe, expect, test, fetch */

jest.mock('../app/telemetry/logger', () => ({ error: jest.fn(), info: jest.fn(), warn: jest.fn() }));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureMessage: jest.fn(), captureException: jest.fn() },
}));
jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const express = require('express');

const TRANSFER = {
  fromAccount: 'ACCT-1001',
  toAccount: 'ACCT-1002',
  amount: 500,
  accountTier: 'premium',
  userId: 'usr_banking_1',
};

function loadBanking(windowMs) {
  jest.resetModules();
  if (windowMs === undefined) delete process.env.TRANSFER_DEDUPE_WINDOW_MS;
  else process.env.TRANSFER_DEDUPE_WINDOW_MS = String(windowMs);
  return require('../app/services/oncall-verticals/banking');
}

let randomSpy;
beforeAll(() => { randomSpy = jest.spyOn(Math, 'random').mockReturnValue(0.5); });
afterAll(async () => {
  randomSpy.mockRestore();
  delete process.env.TRANSFER_DEDUPE_WINDOW_MS;
  await require('../app/services/oncall-verticals/industrials-edge').stopGateway();
});

describe('banking transfer dedupe window', () => {
  test('defaults to 0, so the same transfer submitted twice settles twice', async () => {
    const { processTransfer, TRANSFER_IDEMPOTENCY } = loadBanking(undefined);
    expect(TRANSFER_IDEMPOTENCY.dedupeWindowMs).toBe(0);

    const first = await processTransfer({ ...TRANSFER });
    const second = await processTransfer({ ...TRANSFER });

    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    expect(second.duplicate).toBeUndefined();
    expect(second.transferId).not.toBe(first.transferId);
    expect(second.receipt.gatewayRef).not.toBe(first.receipt.gatewayRef);
  });

  test('with a window, a matching resubmit is answered from the ledger', async () => {
    const { processTransfer } = loadBanking(30000);

    const first = await processTransfer({ ...TRANSFER });
    const second = await processTransfer({ ...TRANSFER });

    expect(first.duplicate).toBeUndefined();
    expect(second.duplicate).toBe(true);
    expect(second.transferId).toBe(first.transferId);
    expect(second.receipt).toEqual(first.receipt);
    expect(second.receipt.gatewayRef).toMatch(/^GW-ACCT-1001-\d+$/);
  });

  test('a different amount, destination or user is not treated as a duplicate', async () => {
    const { processTransfer } = loadBanking(30000);

    const first = await processTransfer({ ...TRANSFER });
    const otherAmount = await processTransfer({ ...TRANSFER, amount: 501 });
    const otherAccount = await processTransfer({ ...TRANSFER, toAccount: 'ACCT-1003' });
    const otherUser = await processTransfer({ ...TRANSFER, userId: 'usr_banking_2' });

    for (const result of [otherAmount, otherAccount, otherUser]) {
      expect(result.duplicate).toBeUndefined();
      expect(result.transferId).not.toBe(first.transferId);
    }
  });

  test('a resubmit after the window closes settles again', async () => {
    const { processTransfer } = loadBanking(1);

    const first = await processTransfer({ ...TRANSFER });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await processTransfer({ ...TRANSFER });

    expect(second.duplicate).toBeUndefined();
    expect(second.transferId).not.toBe(first.transferId);
  });

  test('the route returns the duplicate flag to the client', async () => {
    loadBanking(30000);
    const routes = require('../app/routes/oncall-verticals');
    const app = express();
    app.use(express.json());
    app.use(routes);
    const server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const post = () => fetch(`http://127.0.0.1:${server.address().port}/api/oncall/banking/transfer`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(TRANSFER),
    }).then((r) => r.json());

    try {
      const first = await post();
      const second = await post();
      expect(first.duplicate).toBeUndefined();
      expect(second.duplicate).toBe(true);
      expect(second.transferId).toBe(first.transferId);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
