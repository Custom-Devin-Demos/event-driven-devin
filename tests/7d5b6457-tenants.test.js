jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const service = require('../app/services/verticals/7d5b6457');
const { createSessionAndAlert } = require('../app/services/devin-session');

const { submitEnforcementRequest, getTenant, TENANTS, clock } = service;

const DEFAULT_REQUEST = {
  instrumentId: 'JDG-4470099812',
  requestType: 'financial',
  amount: 85000,
  details: 'لم يسدد المنفذ ضده المبلغ المحكوم به',
};

describe('enforcement-request tenants', () => {
  const realSleep = clock.sleep;
  let slept;

  beforeEach(() => {
    createSessionAndAlert.mockClear();
    slept = 0;
    clock.sleep = async (ms) => { slept += ms; };
  });

  afterAll(() => {
    clock.sleep = realSleep;
  });

  it('accepts promissory-note and notarized-contract requests on every tenant', async () => {
    for (const slug of Object.keys(TENANTS)) {
      for (const instrumentId of ['PN-2291', 'NC-7713']) {
        const result = await submitEnforcementRequest({ ...DEFAULT_REQUEST, tenant: slug, instrumentId });
        expect(result.success).toBe(true);
        expect(result.request.requestNumber).toMatch(/^\d{12}$/);
      }
    }
    expect(slept).toBeLessThan(2000);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  it('gives every tenant its own court circuit so one fix cannot resolve another', () => {
    const circuits = Object.values(TENANTS).map((tenant) => tenant.courtCircuit);
    expect(new Set(circuits).size).toBe(circuits.length);
  });

  it('rejects an unknown or missing tenant as a 400 rather than serving a shared demo', async () => {
    await expect(submitEnforcementRequest({ ...DEFAULT_REQUEST, tenant: 'nope' }))
      .rejects.toMatchObject({ name: 'ValidationError', code: 'UNKNOWN_TENANT', statusCode: 400 });
    await expect(submitEnforcementRequest(DEFAULT_REQUEST))
      .rejects.toMatchObject({ code: 'UNKNOWN_TENANT' });
    expect(getTenant('')).toBeUndefined();
    expect(getTenant('NOUF')).toBe(TENANTS.nouf);
  });

  it('rejects malformed requests before contacting the registry', async () => {
    await expect(submitEnforcementRequest({ ...DEFAULT_REQUEST, tenant: 'nouf', amount: -5 }))
      .rejects.toMatchObject({ code: 'INVALID_AMOUNT', statusCode: 400 });
    await expect(submitEnforcementRequest({ ...DEFAULT_REQUEST, tenant: 'nouf', instrumentId: 'X' }))
      .rejects.toMatchObject({ code: 'UNKNOWN_INSTRUMENT', statusCode: 400 });
    await expect(submitEnforcementRequest({ ...DEFAULT_REQUEST, tenant: 'nouf', requestType: 'x' }))
      .rejects.toMatchObject({ code: 'UNKNOWN_REQUEST_TYPE', statusCode: 400 });
    expect(slept).toBe(0);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  it('fails the court-judgment request with a 504 and alerts under the tenant label and circuit', async () => {
    await expect(submitEnforcementRequest({ ...DEFAULT_REQUEST, tenant: 'nouf' }))
      .rejects.toMatchObject({ name: 'GatewayTimeoutError', statusCode: 504 });

    expect(slept).toBeGreaterThanOrEqual(7000);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('7d5b6457');
    expect(alert.verticalLabel).toBe(TENANTS.nouf.label);
    expect(alert.tags).toContainEqual({ key: 'circuit', value: 'riyadh-general-nouf' });
    expect(alert.tags).toContainEqual({ key: 'route', value: '/api/7d5b6457/nouf/enforcement-requests' });
  });
});
