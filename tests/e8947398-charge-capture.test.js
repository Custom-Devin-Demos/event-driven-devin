/* global describe, expect, jest, test, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { signEncounter, getSchedule, getChart } = require('../app/services/verticals/e8947398');

describe('Nextech IntelleChartPRO charge capture (e8947398)', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('Humana MA encounter with OCTA crashes pricing and alerts', async () => {
    await expect(signEncounter({ patientId: 'NX-104582' })).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ customer: 'e8947398' }));
  });

  test('Medicare Part B injection encounter posts with drug units', async () => {
    const result = await signEncounter({ patientId: 'NX-104611' });
    expect(result.success).toBe(true);
    expect(result.lines.find((l) => l.cpt === 'J0178').units).toBe(2);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('Aetna PPO new patient adds copay to patient responsibility', async () => {
    const result = await signEncounter({ patientId: 'NX-104655' });
    expect(result.patientResponsibility).toBeCloseTo(71.54, 2);
  });

  test('schedule and chart expose glaucoma IOP history', () => {
    expect(getSchedule().arrived).toHaveLength(3);
    expect(getChart('NX-104582').iopHistory.length).toBeGreaterThan(5);
  });
});
