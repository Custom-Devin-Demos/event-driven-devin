jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const { signIn, getTenant, TENANTS } = require('../app/services/verticals/login');
const { createSessionAndAlert } = require('../app/services/devin-session');

describe('Al Rajhi sign-in tenants', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
  });

  it('serves the shared retail account on every tenant', async () => {
    for (const slug of Object.keys(TENANTS)) {
      const result = await signIn({ tenant: slug, username: '1054118903', password: 'Demo@1234' });
      expect(result.session.segmentLabel).toBe('Retail Banking');
    }
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  it('gives every tenant its own segment key so one fix cannot resolve another', () => {
    const segments = Object.values(TENANTS).map((tenant) => tenant.account.segment);
    expect(new Set(segments).size).toBe(segments.length);
  });

  it('rejects an unknown tenant as a 400 instead of falling back to the default', async () => {
    await expect(signIn({ tenant: 'nope', username: '1054118903', password: 'Demo@1234' }))
      .rejects.toMatchObject({ name: 'ValidationError', code: 'UNKNOWN_TENANT', statusCode: 400 });
    expect(getTenant('nope')).toBeUndefined();
    expect(getTenant('NOUF')).toBe(TENANTS.nouf);
  });

  it('alerts under the failing tenant label and its own segment tag', async () => {
    await expect(signIn({ tenant: 'nouf', username: '1098342271', password: 'Demo@1234' }))
      .rejects.toThrow();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.verticalLabel).toBe(TENANTS.nouf.label);
    expect(alert.tags).toContainEqual({ key: 'segment', value: 'mokafaa_plus_nouf' });
  });
});
