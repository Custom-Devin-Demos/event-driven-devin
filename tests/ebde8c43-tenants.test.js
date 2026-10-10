jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const { releaseHeldPayment, getTenant, TENANTS, SCREENING_LISTS } = require('../app/services/verticals/ebde8c43');
const { createSessionAndAlert } = require('../app/services/devin-session');

describe('held payment release tenants', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
  });

  it('gives every tenant its own unregistered screening list so one fix cannot resolve another', () => {
    const lists = Object.values(TENANTS).map((tenant) => tenant.alert.screeningList);
    expect(new Set(lists).size).toBe(lists.length);
    lists.forEach((list) => expect(SCREENING_LISTS[list]).toBeUndefined());
  });

  it('rejects an unknown or missing tenant as a 400 rather than serving a shared demo', async () => {
    await expect(releaseHeldPayment({ tenant: 'nope', amount: 10 }))
      .rejects.toMatchObject({ name: 'ValidationError', code: 'UNKNOWN_TENANT', statusCode: 400 });
    await expect(releaseHeldPayment({ amount: 10 })).rejects.toMatchObject({ code: 'UNKNOWN_TENANT' });
    expect(getTenant('')).toBeUndefined();
    expect(getTenant('NOUF')).toBe(TENANTS.nouf);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  it('rejects an invalid amount as a 400 without alerting', async () => {
    for (const amount of [0, -5, 'abc', TENANTS.nouf.alert.amount + 1]) {
      await expect(releaseHeldPayment({ tenant: 'nouf', amount }))
        .rejects.toMatchObject({ code: 'INVALID_AMOUNT', statusCode: 400 });
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  it('fails the release with a TypeError and alerts under the tenant label and screening list', async () => {
    await expect(releaseHeldPayment({ tenant: 'nouf', alertId: 'TS-ALR-2026-104382', amount: 482750 }))
      .rejects.toBeInstanceOf(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('ebde8c43');
    expect(alert.verticalLabel).toBe(TENANTS.nouf.label);
    expect(alert.tags).toContainEqual({ key: 'screening_list', value: 'sama_domestic_watchlist_nouf' });
    expect(alert.tags).toContainEqual({ key: 'route', value: '/api/ebde8c43/nouf/release' });
  });
});
