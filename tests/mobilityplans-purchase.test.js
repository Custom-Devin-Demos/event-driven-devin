jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { purchasePlan } = require('../app/services/oncall-verticals/mobilityplans');
const { Sentry } = require('../app/telemetry/sentry');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

describe('mobility plan purchase', () => {
  beforeEach(() => Sentry.captureException.mockClear());

  test('skin c32407c6 uses the error-shaped mobilityplans scenario', () => {
    expect(getOncallSkin('c32407c6')).toMatchObject({ vertical: 'mobilityplans', page: { file: 'c32407c6.html' } });
    expect(ALERT_SCENARIOS.mobilityplans).toMatchObject({
      apiPath: '/api/mobilityplans/purchase',
      oncallApiPath: '/api/oncall/mobilityplans/purchase',
      alertOnStatus: [500],
      unlisted: true,
    });
  });

  test('the default 5G+ Complete purchase fails fast with a TypeError', async () => {
    const started = Date.now();
    await expect(purchasePlan({ accountId: 'CUST-3001', currentPlanCode: 'BASIC-5G', planCode: 'COMPLETE-5G', addon: 'none' }))
      .rejects.toThrow(TypeError);
    expect(Date.now() - started).toBeLessThan(500);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
  });

  test.each(['ESSENTIAL-5G', 'EXPLORE-5G'])('buys %s with a price lock', async (planCode) => {
    const result = await purchasePlan({ accountId: 'CUST-3001', currentPlanCode: 'BASIC-5G', planCode, addon: 'hotspot' });
    expect(result.success).toBe(true);
    expect(result.priceLock.lockedUntil).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('rejects unknown and unchanged plans without paging', async () => {
    await expect(purchasePlan({ currentPlanCode: 'BASIC-5G', planCode: 'NOPE' })).rejects.toMatchObject({ code: 'PLAN_NOT_FOUND' });
    await expect(purchasePlan({ currentPlanCode: 'ESSENTIAL-5G', planCode: 'ESSENTIAL-5G' })).rejects.toMatchObject({ code: 'SAME_PLAN' });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
