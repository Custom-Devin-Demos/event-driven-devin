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

describe('homepage account opening applications (549ee872)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('"Open an account" with the default brokerage selection succeeds', async () => {
    const application = await startApplication({ selection: '', entryPoint: 'Open an account' });

    expect(application.offering).toBe('BRK');
    expect(application.entryPoint).toBe('Open an account');
    expect(application.costs).toMatchObject({ expectedBalance: 2500, accountFee: 0, advisoryBps: 0 });
    expect(application.disclosures.length).toBeGreaterThan(0);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each(OFFERINGS.map((o) => [o.code, o]))('builds an application for catalog offering %s', (code, offering) => {
    const funding = normalizeFunding(undefined, offering);
    const application = buildApplication(offering, funding, `Open ${offering.name}`);

    expect(application.offering).toBe(code);
    expect(application.nextStep).toBe(offering.productPath);
    expect(application.costs.expectedBalance).toBe(Math.max(funding.initialDeposit, offering.minimumDeposit));
    expect(Number.isFinite(application.costs.estimatedAnnualAdvisoryFee)).toBe(true);
    expect(application.disclosures).toContain('Investing involves risk, including risk of loss.');
  });

  test.each(OFFERINGS.map((o) => [o.code]))('startApplication succeeds end to end for selection %s', async (code) => {
    const application = await startApplication({ selection: code, entryPoint: 'Homepage card' });
    expect(application.offering).toBe(code);
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('every catalog offering references a defined fee schedule', () => {
    OFFERINGS.forEach((offering) => {
      expect(FEE_SCHEDULES[offering.feeSchedule]).toBeDefined();
      expect(scheduleFor(offering)).toBe(FEE_SCHEDULES[offering.feeSchedule]);
    });
  });

  test('tiered schedules pick the tier for the expected balance', () => {
    const wealth = OFFERINGS.find((o) => o.code === 'WLTH');
    expect(estimateCosts(wealth, { initialDeposit: 0 }).advisoryBps).toBe(110);
    expect(estimateCosts(wealth, { initialDeposit: 1000000 }).advisoryBps).toBe(90);
    expect(estimateCosts(wealth, { initialDeposit: 5000000 }).advisoryBps).toBe(70);

    const college = OFFERINGS.find((o) => o.code === '529');
    expect(estimateCosts(college, { initialDeposit: 25000 }).advisoryBps).toBe(35);
    expect(estimateCosts(college, { initialDeposit: 25001 }).advisoryBps).toBe(25);
  });

  test('unknown fee schedule key fails with a descriptive error instead of a TypeError', () => {
    const broken = { ...OFFERINGS[0], feeSchedule: 'does-not-exist' };
    expect(() => estimateCosts(broken, { initialDeposit: 100 })).toThrow("Unknown fee schedule 'does-not-exist'");
    expect(() => buildDisclosures(broken)).toThrow("Unknown fee schedule 'does-not-exist'");
  });

  test('malformed funding input falls back to defaults', async () => {
    const application = await startApplication({ entryPoint: 'Open an account', funding: { initialDeposit: 'abc', method: 'crypto', registration: 'llc' } });
    expect(application.costs.expectedBalance).toBe(2500);
    expect(application.fundingMethod).toBe('eft');
    expect(application.registration).toBe('individual');
  });
});
