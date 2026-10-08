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

let createSessionAndAlert;
let Sentry;
let strikeNav;
let releaseNav;
let resetCycle;
let getCycle;
let DEFAULT_FUND;

describe('State Street MCH NAV Oversight (statestreet-mch)', () => {
  beforeEach(() => {
    jest.resetModules();
    ({ createSessionAndAlert } = require('../app/services/devin-session'));
    ({ Sentry } = require('../app/telemetry/sentry'));
    ({
      strikeNav, releaseNav, resetCycle, getCycle, DEFAULT_FUND,
    } = require('../app/services/verticals/statestreet-mch'));
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

  test('a failed strike stays FAILED in the cycle until re-struck or reset', async () => {
    await expect(strikeNav({ fundId: DEFAULT_FUND })).rejects.toThrow(TypeError);
    const fund = getCycle().funds.find((f) => f.fundId === DEFAULT_FUND);
    expect(fund.status).toBe('FAILED');
    expect(() => releaseNav({ fundId: DEFAULT_FUND })).toThrow(expect.objectContaining({ code: 'NAV_NOT_RELEASABLE' }));
  });

  test('SOD reset reopens every fund, including the seeded RELEASED sample', async () => {
    await expect(strikeNav({ fundId: DEFAULT_FUND })).rejects.toThrow(TypeError);
    resetCycle();
    const cycle = getCycle();
    cycle.funds.forEach((f) => expect(f.status).toBe('PRICED'));
    const result = await strikeNav({ fundId: 'SSGA-FI-0118' });
    expect(result.status).toBe('STRUCK');
  });

  test('a strike in flight during SOD reset is discarded', async () => {
    const pending = strikeNav({ fundId: 'SSGA-EQ-0042' });
    resetCycle();
    await expect(pending).rejects.toMatchObject({ code: 'CYCLE_RESET', statusCode: 409 });
    expect(getCycle().funds.find((f) => f.fundId === 'SSGA-EQ-0042').status).toBe('PRICED');
  });

  test('inherited object keys are not accepted as fund IDs', async () => {
    await expect(strikeNav({ fundId: 'toString' })).rejects.toMatchObject({ code: 'FUND_NOT_IN_CYCLE' });
    expect(() => releaseNav({ fundId: '__proto__' })).toThrow(expect.objectContaining({ code: 'FUND_NOT_IN_CYCLE' }));
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('tagless Sentry issue webhooks for this vertical are skipped (instant path already alerted)', () => {
    const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/statestreet-mch.js — valuePosition', tags: [] })).toBe(true);
  });
});
