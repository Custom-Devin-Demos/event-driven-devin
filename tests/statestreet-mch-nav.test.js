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
const {
  strikeNav,
  releaseNav,
  resetCycle,
  getCycle,
  DEFAULT_FUND,
} = require('../app/services/verticals/statestreet-mch');

describe('State Street MCH NAV Oversight (statestreet-mch)', () => {
  beforeEach(() => {
    resetCycle();
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('striking the default emerging-markets fund fails with a TypeError and raises an alert', async () => {
    await expect(strikeNav({ fundId: DEFAULT_FUND })).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('statestreet-mch');
    expect(alert.slackMemberId).toBe('U0BQZBHCNMA');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('valuePosition');
    expect(alert.promptAppendix).toContain('app/services/verticals/statestreet-mch.js');
  });

  test('funds fully covered by the FX snapshot strike within tolerance and can be released', async () => {
    const result = await strikeNav({ fundId: 'SSGA-EQ-0042' });

    expect(result.success).toBe(true);
    expect(result.status).toBe('STRUCK');
    expect(result.strike.withinTolerance).toBe(true);
    expect(result.strike.navPerShare).toBeGreaterThan(0);
    expect(result.strike.valuationDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();

    expect(releaseNav({ fundId: 'SSGA-EQ-0042' }).status).toBe('RELEASED');
    const fund = getCycle().funds.find((f) => f.fundId === 'SSGA-EQ-0042');
    expect(fund.status).toBe('RELEASED');
  });

  test('rejections return 4xx without raising an alert', async () => {
    await expect(strikeNav({ fundId: 'SSGA-XX-0000' })).rejects.toMatchObject({
      name: 'ValidationError', statusCode: 404, code: 'FUND_NOT_IN_CYCLE',
    });
    await expect(strikeNav({ fundId: 'SSGA-FI-0118' })).rejects.toMatchObject({
      name: 'ValidationError', statusCode: 409, code: 'NAV_ALREADY_RELEASED',
    });
    expect(() => releaseNav({ fundId: 'SSGA-GL-0007' })).toThrow(expect.objectContaining({ code: 'NAV_NOT_RELEASABLE' }));
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('cycle lists the on-call roster and released funds with their struck NAV', () => {
    const cycle = getCycle();
    expect(cycle.defaultFund).toBe(DEFAULT_FUND);
    expect(cycle.onCall.map((m) => m.name)).toContain('Humza Rabbani');
    const released = cycle.funds.filter((f) => f.status === 'RELEASED');
    expect(released.length).toBeGreaterThan(0);
    released.forEach((f) => expect(f.strike.navPerShare).toBeGreaterThan(0));
  });
});
