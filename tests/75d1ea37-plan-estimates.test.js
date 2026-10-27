jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));
jest.mock('../app/telemetry/logger', () => ({
  info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(),
}));
jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(), recordTiming: jest.fn(),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { estimatePlans, resolveSupplyPoint, PLANS } = require('../app/services/verticals/75d1ea37');

const DEFAULT_ADDRESS = '12 Harris Street, Pyrmont NSW 2009';

describe('AGL plan estimates (75d1ea37)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('prices every plan for a basic-metered Ausgrid address', async () => {
    const result = await estimatePlans({ address: '41 Campbell Parade, Bondi Beach NSW 2026' });
    expect(result.success).toBe(true);
    expect(result.quoteId).toMatch(/^AGL-Q-[0-9A-F]{8}$/);
    expect(result.supplyPoint).toMatchObject({ network: 'Ausgrid', tariffCode: 'EA010', state: 'NSW' });
    expect(result.plans.map((p) => p.id)).toEqual(PLANS.map((p) => p.id));
    expect(result.plans[0].electricity.annual).toBeGreaterThan(1000);
    expect(result.plans[0].gas.annual).toBeGreaterThan(400);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('VIC addresses compare against the Victorian Default Offer', async () => {
    const result = await estimatePlans({ address: '220 Lygon Street, Carlton VIC 3053', gas: false });
    expect(result.plans[0].electricity.referenceScheme).toBe('VDO');
    expect(result.plans[0].gas).toBeUndefined();
  });

  test('rejects unknown addresses and empty fuel selection with 400s', async () => {
    expect(() => resolveSupplyPoint('1 Nowhere Road, Nowhere NSW 2999')).toThrow(expect.objectContaining({ statusCode: 400, code: 'ADDRESS_NOT_FOUND' }));
    await expect(estimatePlans({ address: DEFAULT_ADDRESS, electricity: false, gas: false })).rejects.toMatchObject({ statusCode: 400, code: 'FUEL_REQUIRED' });
  });

  test('default smart-metered Ausgrid address fails and raises the incident', async () => {
    await expect(estimatePlans({ address: DEFAULT_ADDRESS, devinUserId: 'u1' })).rejects.toThrow(TypeError);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    const [, ctx] = Sentry.captureException.mock.calls[0];
    expect(ctx.extra).not.toHaveProperty('address');
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: '75d1ea37',
      service: 'customer-75d1ea37-plan-pricing',
      devinUserId: 'u1',
    }));
  });
});
