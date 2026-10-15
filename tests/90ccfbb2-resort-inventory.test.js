/* global describe, expect, test, jest, beforeEach */

jest.mock('axios', () => jest.fn());
jest.mock('../app/services/oncall', () => ({
  postOncallAlert: jest.fn(() => Promise.resolve({ ok: true, ts: '1.2', channel: 'C0BNWUGCWBS' })),
}));
jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn(() => Promise.resolve({ id: 'dd-1', publicId: 9 })),
}));

const axios = require('axios');
const { postOncallAlert } = require('../app/services/oncall');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const svc = require('../app/services/verticals/90ccfbb2');
const { getCustomerConfig } = require('../config/customers');

const flush = () => new Promise((resolve) => setImmediate(resolve)); // eslint-disable-line no-undef

function respond(routes) {
  axios.mockImplementation(({ url }) => {
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    return Promise.resolve(key ? routes[key] : { status: 404, data: { code: 'NOT_FOUND', error: 'nope' } });
  });
}

const SOLD_OUT_CAL = { status: 200, data: { productId: 'wdw-mk', days: [{ date: '2026-11-28', status: 'SOLD_OUT', priceFromUsd: 179 }] } };
const OPEN_CAL = { status: 200, data: { productId: 'wdw-mk', days: [{ date: '2026-11-27', status: 'AVAILABLE', priceFromUsd: 169 }] } };
const LEAKING_AUDIT = {
  status: 200,
  data: {
    soldOutWithCapacity: [{ productId: 'wdw-mk', date: '2026-11-28', capacity: 1200, sold: 1116, held: 84, unsoldCapacity: 84 }],
    activeHolds: 74,
    holdsPastExpiry: 74,
  },
};

beforeEach(() => {
  jest.clearAllMocks();
  svc.resetMonitorForTests();
});

describe('Disney Parks resort-inventory facade', () => {
  test('registers the customer', () => {
    expect(getCustomerConfig('90ccfbb2').label).toMatch(/Disney Parks/);
  });

  test('open calendars never evaluate the monitor', async () => {
    respond({ '/api/availability': OPEN_CAL });
    await svc.getAvailability({ productId: 'wdw-mk', from: '2026-11-01', days: 30 });
    await flush();
    expect(axios).toHaveBeenCalledTimes(1);
    expect(postOncallAlert).not.toHaveBeenCalled();
  });

  test('sold out with unsold capacity fires the On-Call card and a SEV-2 incident once per cooldown', async () => {
    respond({ '/api/availability': SOLD_OUT_CAL, '/internal/inventory/audit': LEAKING_AUDIT });
    const first = await svc.evaluateCapacityMonitor({ devinEmail: 'giri@cognition.ai' });
    const second = await svc.evaluateCapacityMonitor({ devinEmail: 'giri@cognition.ai' });

    expect(first).toMatchObject({ fired: true, rows: 1 });
    expect(second).toMatchObject({ fired: false, cooldown: true });
    expect(postOncallAlert).toHaveBeenCalledTimes(1);
    expect(postOncallAlert).toHaveBeenCalledWith('90ccfbb2', expect.objectContaining({ devinEmail: 'giri@cognition.ai' }));
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({ severity: 'SEV-2', service: 'resort-inventory' }));
  });

  test('genuinely sold-out dates do not alert', async () => {
    respond({ '/internal/inventory/audit': { status: 200, data: { soldOutWithCapacity: [], activeHolds: 0 } } });
    await expect(svc.evaluateCapacityMonitor({})).resolves.toMatchObject({ fired: false, rows: 0 });
    expect(postOncallAlert).not.toHaveBeenCalled();
  });

  test('an unreachable inventory service is a 503, not a crash', async () => {
    axios.mockImplementation(() => Promise.reject(new Error('connect ECONNREFUSED')));
    await expect(svc.getAvailability({ productId: 'wdw-mk', from: '2026-11-01' }))
      .rejects.toMatchObject({ statusCode: 503, code: 'INVENTORY_UNAVAILABLE' });
  });

  test('rejects malformed input before calling the service', async () => {
    await expect(svc.createHold({ productId: '../admin', date: '2026-11-01' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(svc.checkout({ holdId: 'x' })).rejects.toMatchObject({ statusCode: 400 });
    expect(axios).not.toHaveBeenCalled();
  });

  test('passes sold-out holds through as 409', async () => {
    respond({ '/api/holds': { status: 409, data: { code: 'SOLD_OUT', error: 'Magic Kingdom Park is sold out for 2026-11-28' } } });
    await expect(svc.createHold({ productId: 'wdw-mk', date: '2026-11-28', quantity: 2 }))
      .rejects.toMatchObject({ statusCode: 409, code: 'SOLD_OUT' });
  });

  test('a ledger posting failure is a 500 that captures to Sentry and raises the On-Call alert', async () => {
    respond({ '/api/holds': { status: 500, data: { code: 'LEDGER_POSTING_FAILED', error: 'HLDPOST rc=16: HLD0042E NO RATE ENTRY FOR SEASON P HOLD H-1234ABCD' } } });
    await expect(svc.createHold({ productId: 'wdw-mk', date: '2026-11-28', quantity: 4, devinEmail: 'giri@cognition.ai' }))
      .rejects.toMatchObject({ statusCode: 500, code: 'HOLD_FAILED', detail: expect.stringContaining('HLD0042E') });
    await flush();
    expect(postOncallAlert).toHaveBeenCalledWith('90ccfbb2', expect.objectContaining({ devinEmail: 'giri@cognition.ai' }));
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({ severity: 'SEV-2' }));
  });
});
