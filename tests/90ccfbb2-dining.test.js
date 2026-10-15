/* global describe, expect, test, jest, beforeEach, setImmediate */

jest.mock('axios', () => jest.fn());
jest.mock('../app/services/oncall', () => ({ postOncallAlert: jest.fn(() => Promise.resolve({ ok: true })) }));
jest.mock('../app/services/datadog-incidents', () => ({ declareDatadogIncident: jest.fn(() => Promise.resolve({ ok: true })) }));

const axios = require('axios');
const { postOncallAlert } = require('../app/services/oncall');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const dining = require('../app/services/verticals/90ccfbb2-dining');

const flush = () => new Promise((resolve) => setImmediate(resolve));

function provider(day) {
  axios.mockImplementation(({ url }) => {
    if (url.endsWith('/api/availability')) return Promise.resolve({ status: 200, data: { productId: 'wdw-bog', days: [day] } });
    if (url.endsWith('/api/holds')) return Promise.resolve({ status: 201, data: { id: 'H-1234ABCD' } });
    if (url.endsWith('/api/checkout')) return Promise.resolve({ status: 200, data: { confirmation: 'WDPR-1234ABCD' } });
    return Promise.resolve({ status: 404, data: {} });
  });
}

const reservation = { restaurantId: 'wdw-bog', date: '2026-11-21', time: '6:30 PM', partySize: 4, devinEmail: 'giri@cognition.ai' };

beforeEach(() => {
  jest.clearAllMocks();
});

describe('Disney Dining reservations (90ccfbb2/dining)', () => {
  test('availability passes the provider status through', async () => {
    provider({ date: '2026-11-21', status: 'LIMITED', priceFromUsd: 89 });
    await expect(dining.getDiningAvailability({ restaurantId: 'wdw-bog', date: '2026-11-21' }))
      .resolves.toEqual({ restaurantId: 'wdw-bog', date: '2026-11-21', status: 'LIMITED' });
  });

  test('books a table and quotes the estimate and no-show fee', async () => {
    provider({ date: '2026-11-21', status: 'AVAILABLE', priceFromUsd: 89 });
    await expect(dining.createReservation(reservation)).resolves.toMatchObject({
      confirmation: 'WDPR-1234ABCD', partySize: 4, perAdult: 89, estimatedTotal: 356, noShowFee: 40,
    });
    expect(postOncallAlert).not.toHaveBeenCalled();
  });

  test('sold-out dates are a 409, not an alert', async () => {
    provider({ date: '2026-11-21', status: 'SOLD_OUT', priceFromUsd: 89 });
    await expect(dining.createReservation(reservation)).rejects.toMatchObject({ statusCode: 409, code: 'NO_TABLES' });
    expect(postOncallAlert).not.toHaveBeenCalled();
  });

  test('rejects malformed input before calling the provider', async () => {
    await expect(dining.createReservation({ ...reservation, restaurantId: '../x' })).rejects.toMatchObject({ statusCode: 400 });
    await expect(dining.createReservation({ ...reservation, partySize: 12 })).rejects.toMatchObject({ statusCode: 400 });
    expect(axios).not.toHaveBeenCalled();
  });

  test('a quote failure is a 500 that raises one On-Call alert and SEV-2 per cooldown', async () => {
    provider({ date: '2026-11-21', status: 'AVAILABLE' });
    await expect(dining.createReservation(reservation))
      .rejects.toMatchObject({ statusCode: 500, code: 'RESERVATION_FAILED', reference: expect.stringMatching(/^DIN-[0-9A-F]{6}$/) });
    await expect(dining.createReservation(reservation)).rejects.toMatchObject({ code: 'RESERVATION_FAILED' });
    await flush();
    expect(postOncallAlert).toHaveBeenCalledTimes(1);
    expect(postOncallAlert).toHaveBeenCalledWith('90ccfbb2-dining', expect.objectContaining({ devinEmail: 'giri@cognition.ai' }));
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({ severity: 'SEV-2', service: 'dining-reservations' }));
  });
});
