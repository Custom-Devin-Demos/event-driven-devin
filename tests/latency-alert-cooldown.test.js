/* global afterEach, beforeEach, describe, expect, jest, test */

const {
  latencyAlertKey,
  claimLatencyAlert,
  releaseLatencyAlert,
  startedInvestigation,
  resetLatencyAlertCooldowns,
  DEFAULT_COOLDOWN_MS,
} = require('../app/services/latency-alert-cooldown');

beforeEach(() => resetLatencyAlertCooldowns());
afterEach(() => jest.restoreAllMocks());

describe('latency alert cooldown claims', () => {
  test('exports the configured cooldown or the 10-minute default', () => {
    expect(DEFAULT_COOLDOWN_MS).toBe(Number(process.env.LATENCY_ALERT_COOLDOWN_MS) || 10 * 60 * 1000);
  });

  test('allows one claim and rejects another within the cooldown', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);

    expect(claimLatencyAlert('vertical', 100)).toEqual(expect.any(Number));
    expect(claimLatencyAlert('vertical', 100)).toBeNull();
  });

  test('allows a new claim after the cooldown expires', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);

    const firstClaim = claimLatencyAlert('vertical', 100);
    now.mockReturnValue(1101);
    const secondClaim = claimLatencyAlert('vertical', 100);

    expect(secondClaim).toEqual(expect.any(Number));
    expect(secondClaim).not.toBe(firstClaim);
  });

  test('a stale token cannot release a newer claim', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);
    const key = 'vertical:org';
    const firstClaim = claimLatencyAlert(key, 100);
    now.mockReturnValue(1101);
    const secondClaim = claimLatencyAlert(key, 100);

    releaseLatencyAlert(key, firstClaim);

    expect(claimLatencyAlert(key, 100)).toBeNull();
    expect(secondClaim).not.toBe(firstClaim);
  });

  test('matching token release allows the key to be claimed again', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);
    const key = 'vertical:org';
    const claim = claimLatencyAlert(key, 100);

    releaseLatencyAlert(key, claim);
    expect(claimLatencyAlert(key, 100)).toEqual(expect.any(Number));
  });

  test('keeps claims independent by key', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);

    expect(claimLatencyAlert('first', 100)).toEqual(expect.any(Number));
    expect(claimLatencyAlert('second', 100)).toEqual(expect.any(Number));
    expect(claimLatencyAlert('first', 100)).toBeNull();
  });

  test('builds a key from the vertical and organization, defaulting the organization', () => {
    expect(latencyAlertKey('vertical')).toBe('vertical:default');
    expect(latencyAlertKey('vertical', 'org')).toBe('vertical:org');
  });

  test.each([
    [null, false],
    [{ session: null, throttled: true }, false],
    [{ session: null, throttled: false }, false],
    [{ session: {} }, true],
    [{ session: null, teams: true }, true],
    [{ session: null, incident: {} }, true],
  ])('reports whether an investigation started for %p', (result, expected) => {
    expect(startedInvestigation(result)).toBe(expected);
  });
});
