/* global describe, expect, test, jest, afterEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ ok: true })),
}));

const express = require('express');
const http = require('http');

const { createSessionAndAlert } = require('../app/services/devin-session');
const orderRoutes = require('../app/routes/verticals/6dc826a1');
const {
  submitOrder,
  calculateCommission,
  resolveFeeSchedule,
  assignRoutingDesk,
  ORDER_TYPES,
  FEE_SCHEDULES,
} = require('../app/services/verticals/6dc826a1');

const BOOKED_SCHEDULE = {
  label: 'Advisory Wrap — 2026 Schedule',
  commissionBps: 0,
  minimumCommission: 0,
  ticketCharge: 0,
  secFeeBps: 0.278,
  settlementDays: 1,
  routingDesk: 'advisory-implementation',
};

function postOrder(body) {
  const app = express();
  app.use(express.json());
  app.use(orderRoutes);

  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const { port } = server.address();
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          host: '127.0.0.1',
          port,
          path: '/api/6dc826a1/order',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
        },
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

const ADVISORY_ORDER = {
  accountNumber: 'WM-4417-20913',
  symbol: 'AAPL',
  side: 'buy',
  quantity: 2500,
  orderType: 'advisory_wrap',
};

afterEach(() => {
  delete FEE_SCHEDULES.advisory_wrap_2026;
  createSessionAndAlert.mockClear();
});

describe('advisor trade booking — commission pricing', () => {
  test('books a market order against the registered agency schedule', async () => {
    const order = await submitOrder({
      ...ADVISORY_ORDER,
      orderType: 'market',
    });

    expect(order.success).toBe(true);
    expect(order.orderId).toMatch(/^MS-ORD-[0-9A-F]{8}$/);
    expect(order.feeScheduleLabel).toBe('Equity Agency — Market');
    expect(order.executionPrice).toBe(227.48);
    expect(order.principal).toBe(568700);
    expect(order.commission).toBe(682.44);
    expect(order.ticketCharge).toBe(4.95);
    expect(order.totalFees).toBe(688.97);
    expect(order.estimatedProceeds).toBe(569388.97);
    expect(order.routingDesk.id).toBe('DESK-118');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('prices a limit order off the advisor-supplied limit price', async () => {
    const order = await submitOrder({
      ...ADVISORY_ORDER,
      orderType: 'limit',
      quantity: 100,
      limitPrice: 220,
    });

    expect(order.executionPrice).toBe(220);
    expect(order.principal).toBe(22000);
    expect(order.commission).toBe(19.95);
    expect(order.feeScheduleLabel).toBe('Equity Agency — Limit');
  });

  test('nets fees out of proceeds and credits cash on a sell', async () => {
    const order = await submitOrder({
      ...ADVISORY_ORDER,
      orderType: 'market',
      side: 'sell',
    });

    expect(order.side).toBe('Sell');
    expect(order.totalFees).toBe(688.97);
    expect(order.estimatedProceeds).toBe(568011.03);
    expect(order.cashRemaining).toBe(1854441.21);
  });

  test('assigns the routing desk named by the fee schedule', () => {
    const schedule = resolveFeeSchedule(ORDER_TYPES.market);
    expect(assignRoutingDesk(schedule).name).toBe('Equity Agency Desk');
  });
});

describe('advisor trade booking — unregistered fee schedule (failing path)', () => {
  test('resolveFeeSchedule has no entry for the advisory wrap order type', () => {
    expect(ORDER_TYPES.advisory_wrap.feeScheduleCode).toBe('advisory_wrap_2026');
    expect(resolveFeeSchedule(ORDER_TYPES.advisory_wrap)).toBeUndefined();
  });

  test('calculateCommission throws a TypeError on the unregistered schedule', () => {
    expect(() => calculateCommission(ORDER_TYPES.advisory_wrap, 568700)).toThrow(TypeError);
    expect(() => calculateCommission(ORDER_TYPES.advisory_wrap, 568700))
      .toThrow(/Cannot read properties of undefined \(reading 'commissionBps'\)/);
  });

  test('submitOrder surfaces the TypeError and raises a Devin session alert', async () => {
    await expect(submitOrder(ADVISORY_ORDER)).rejects.toThrow(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.service).toBe('6dc826a1-api');
    expect(alert.culprit).toBe('app/services/verticals/6dc826a1.js — calculateCommission');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.tags).toEqual(expect.arrayContaining([
      { key: 'route', value: '/api/6dc826a1/order' },
      { key: 'feeScheduleCode', value: 'advisory_wrap_2026' },
    ]));
  });

  test('POST /api/6dc826a1/order returns 500 for the advisory wrap ticket', async () => {
    const { status, body } = await postOrder(ADVISORY_ORDER);

    expect(status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.errorClass).toBe('TypeError');
    expect(body.code).toBe('ORDER_BOOKING_FAILED');
  });
});

describe('advisor trade booking — fixed behaviour once the schedule is registered', () => {
  test('books the advisory wrap ticket with zero commission and no alert', async () => {
    FEE_SCHEDULES.advisory_wrap_2026 = { ...BOOKED_SCHEDULE };

    const order = await submitOrder(ADVISORY_ORDER);

    expect(order.success).toBe(true);
    expect(order.feeScheduleLabel).toBe('Advisory Wrap — 2026 Schedule');
    expect(order.commission).toBe(0);
    expect(order.ticketCharge).toBe(0);
    expect(order.totalFees).toBe(1.58);
    expect(order.principal).toBe(568700);
    expect(order.estimatedProceeds).toBe(568701.58);
    expect(order.routingDesk.name).toBe('Advisory Implementation Desk');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('POST /api/6dc826a1/order returns 200 once the schedule is registered', async () => {
    FEE_SCHEDULES.advisory_wrap_2026 = { ...BOOKED_SCHEDULE };

    const { status, body } = await postOrder(ADVISORY_ORDER);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.status).toBe('accepted');
    expect(body.orderTypeLabel).toBe('Advisory Wrap — Discretionary');
  });
});

describe('advisor trade booking — request validation', () => {
  test('rejects an unknown client account with a 400 and no alert', async () => {
    const { status, body } = await postOrder({ ...ADVISORY_ORDER, accountNumber: 'WM-0000-00000' });

    expect(status).toBe(400);
    expect(body.errorClass).toBe('ValidationError');
    expect(body.error).toMatch(/Unknown client account/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('rejects a non-positive quantity', async () => {
    const { status, body } = await postOrder({ ...ADVISORY_ORDER, quantity: 0 });

    expect(status).toBe(400);
    expect(body.error).toMatch(/positive number of shares/);
  });

  test('requires a limit price for limit orders', async () => {
    const { status, body } = await postOrder({
      ...ADVISORY_ORDER,
      orderType: 'limit',
      limitPrice: null,
    });

    expect(status).toBe(400);
    expect(body.error).toMatch(/limit price is required/);
  });
});
