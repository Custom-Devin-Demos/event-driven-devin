/* global afterEach, beforeEach, describe, expect, jest, test */

const {
  claimLatencyAlert,
  releaseLatencyAlert,
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

    expect(claimLatencyAlert('vertical', 100)).toBe(true);
    expect(claimLatencyAlert('vertical', 100)).toBe(false);
  });

  test('allows a new claim after the cooldown expires', () => {
    const now = jest.spyOn(Date, 'now').mockReturnValue(1000);

    expect(claimLatencyAlert('vertical', 100)).toBe(true);
    now.mockReturnValue(1101);
    expect(claimLatencyAlert('vertical', 100)).toBe(true);
  });

  test('release allows the key to be claimed again', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);

    expect(claimLatencyAlert('vertical', 100)).toBe(true);
    releaseLatencyAlert('vertical');
    expect(claimLatencyAlert('vertical', 100)).toBe(true);
  });

  test('keeps claims independent by key', () => {
    jest.spyOn(Date, 'now').mockReturnValue(1000);

    expect(claimLatencyAlert('first', 100)).toBe(true);
    expect(claimLatencyAlert('second', 100)).toBe(true);
    expect(claimLatencyAlert('first', 100)).toBe(false);
  });
});
