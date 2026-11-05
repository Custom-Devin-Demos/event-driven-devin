jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve({ triggered: false })),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { startApplication, buildApplication, normalizeFunding } = require('../app/services/verticals/549ee872');
const { OFFERINGS, FEE_SCHEDULES } = require('../app/services/verticals/549ee872-catalog');
const { estimateCosts, buildDisclosures, scheduleFor } = require('../app/services/verticals/549ee872-pricing');

describe('549ee872 homepage account opening', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('"Open an account" (BRK, retail-brokerage) succeeds without raising an alert', async () => {
    const application = await startApplication({ selection: 'BRK', entryPoint: 'Open an account' });

    expect(application.offering).toBe('BRK');
    expect(application.costs).toEqual({
      expectedBalance: 2500,
      accountFee: 0,
      commissionPerTrade: 0,
      advisoryBps: 0,
      estimatedAnnualAdvisoryFee: 0,
    });
    expect(application.disclosures).toContain('$0 commission for online US stock, ETF, and option trades.');
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each(OFFERINGS.map((o) => [o.code, o]))('builds an application for catalog offering %s', (code, offering) => {
    const funding = normalizeFunding(undefined, offering);
    const application = buildApplication(offering, funding, 'Open an account');
    const schedule = FEE_SCHEDULES[offering.feeSchedule];

    expect(application.offering).toBe(code);
    expect(application.nextStep).toBe(offering.productPath);
    expect(application.costs.expectedBalance).toBe(Math.max(funding.initialDeposit, offering.minimumDeposit));
    expect(schedule.tiers).toContainEqual(expect.objectContaining({ advisoryBps: application.costs.advisoryBps }));
    expect(Number.isFinite(application.costs.estimatedAnnualAdvisoryFee)).toBe(true);
    expect(application.disclosures.length).toBeGreaterThan(0);
  });

  test.each(OFFERINGS.map((o) => [o.code]))('startApplication succeeds for offering %s', async (code) => {
    const application = await startApplication({ selection: code, entryPoint: 'Open an account' });
    expect(application.offering).toBe(code);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('picks the correct tier for a tiered schedule', () => {
    const wealth = OFFERINGS.find((o) => o.code === 'WLTH');
    expect(estimateCosts(wealth, { initialDeposit: 1000000 }).advisoryBps).toBe(90);
    expect(estimateCosts(wealth, { initialDeposit: 0 }).advisoryBps).toBe(110);
    const edu = OFFERINGS.find((o) => o.code === '529');
    expect(estimateCosts(edu, { initialDeposit: 25001 }).advisoryBps).toBe(25);
  });

  test('every offering references a known fee schedule', () => {
    OFFERINGS.forEach((offering) => {
      expect(scheduleFor(offering)).toBe(FEE_SCHEDULES[offering.feeSchedule]);
    });
  });

  test('an unknown fee schedule key fails with a descriptive error, not a TypeError', () => {
    const broken = { ...OFFERINGS[0], feeSchedule: 'does-not-exist' };
    expect(() => estimateCosts(broken, { initialDeposit: 100 })).toThrow("Unknown fee schedule 'does-not-exist' for offering BRK");
    expect(() => buildDisclosures(broken)).toThrow(/Unknown fee schedule/);
    expect(() => scheduleFor({ ...OFFERINGS[0], feeSchedule: undefined })).toThrow(/Unknown fee schedule/);
  });
});
