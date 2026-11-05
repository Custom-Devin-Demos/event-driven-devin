jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const { startApplication, buildApplication, normalizeFunding } = require('../app/services/verticals/549ee872');
const { OFFERINGS, FEE_SCHEDULES, findOffering } = require('../app/services/verticals/549ee872-catalog');
const { estimateCosts, buildDisclosures, scheduleFor } = require('../app/services/verticals/549ee872-pricing');

describe('549ee872 homepage account opening', () => {
  beforeEach(() => jest.clearAllMocks());

  describe.each(OFFERINGS.map((o) => [o.code, o]))('offering %s', (code, offering) => {
    it('builds an application with costs and disclosures', () => {
      const funding = normalizeFunding(undefined, offering);
      const app = buildApplication(offering, funding, 'Open an account');
      expect(app.offering).toBe(code);
      expect(app.nextStep).toBe(offering.productPath);
      expect(app.costs.expectedBalance).toBeGreaterThanOrEqual(offering.minimumDeposit);
      expect(Number.isFinite(app.costs.estimatedAnnualAdvisoryFee)).toBe(true);
      expect(app.disclosures).toContain('Investing involves risk, including risk of loss.');
    });

    it('starts an application end-to-end without reporting a failure', async () => {
      const result = await startApplication({ selection: code, entryPoint: 'Open an account' });
      expect(result.offering).toBe(code);
      expect(result.applicationId).toMatch(/^FA-[0-9A-F]{8}$/);
      expect(Sentry.captureException).not.toHaveBeenCalled();
      expect(createSessionAndAlert).not.toHaveBeenCalled();
    });
  });

  it('opens a BRK application from the "Open an account" entry point (NODE-EXPRESS-E8)', async () => {
    const result = await startApplication({ selection: '', entryPoint: 'Open an account', funding: { initialDeposit: 2500, method: 'eft' } });
    expect(result.offering).toBe('BRK');
    expect(result.costs).toEqual({
      expectedBalance: 2500, accountFee: 0, commissionPerTrade: 0, advisoryBps: 0, estimatedAnnualAdvisoryFee: 0,
    });
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  it('every offering references a defined fee schedule', () => {
    OFFERINGS.forEach((o) => expect(FEE_SCHEDULES[o.feeSchedule]).toBeDefined());
  });

  it('prices tiered schedules by expected balance', () => {
    const wealth = findOffering('WLTH');
    expect(estimateCosts(wealth, { initialDeposit: 0 }).advisoryBps).toBe(110);
    expect(estimateCosts(wealth, { initialDeposit: 3000000 }).advisoryBps).toBe(70);
    expect(estimateCosts(findOffering('529'), { initialDeposit: 30000 }).advisoryBps).toBe(25);
    expect(buildDisclosures(wealth)).toContain('Gross advisory fee 0.70%–1.10% of assets, billed quarterly.');
  });

  it('throws a descriptive error for an unknown fee schedule key', () => {
    const bogus = { ...findOffering('BRK'), feeSchedule: 'does-not-exist' };
    expect(() => scheduleFor(bogus)).toThrow("Unknown fee schedule 'does-not-exist' for offering BRK");
    expect(() => estimateCosts(bogus, { initialDeposit: 100 })).toThrow(/Unknown fee schedule/);
  });
});
