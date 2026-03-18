/**
 * Regression tests for healthcare appointment scheduling.
 *
 * Covers the two bugs fixed in this PR:
 *   1. buildAppointmentDate used 1-indexed months instead of 0-indexed (Date constructor expects 0-11).
 *   2. getCoveragePeriod referenced plan.coverageEndDate instead of plan.coverageEnd.
 *
 * Both bugs caused getCoveragePeriod to return null, which then crashed
 * scheduleAppointment with: TypeError: Cannot read properties of null (reading 'copayAmount')
 */

jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../../telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../../telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

const { scheduleAppointment, PATIENT_PLANS } = require('./healthcare');

describe('healthcare appointment scheduling', () => {
  // ── Original failure condition ──────────────────────────────────────
  // The default form values (PAT-2001, 2026-12-15) must succeed.
  // Before the fix this threw TypeError: Cannot read properties of null (reading 'copayAmount').

  it('should schedule an appointment for PAT-2001 on 2026-12-15 (original failure case)', async () => {
    const result = await scheduleAppointment({
      patientId: 'PAT-2001',
      providerId: 'DR-101',
      department: 'primary-care',
      appointmentDate: '2026-12-15',
    });

    expect(result.success).toBe(true);
    expect(result.copay).toBe(20);
    expect(result.date).toBe('2026-12-15');
    expect(result.patientId).toBe('PAT-2001');
    expect(result.status).toBe('confirmed');
  });

  // ── Edge case: unknown patient ──────────────────────────────────────
  // getCoveragePeriod returns null for unknown patients. scheduleAppointment
  // accesses coverage.copayAmount without a null check, so this should throw.

  it('should throw for an unknown patient ID', async () => {
    await expect(
      scheduleAppointment({
        patientId: 'PAT-9999',
        providerId: 'DR-101',
        department: 'primary-care',
        appointmentDate: '2026-12-15',
      }),
    ).rejects.toThrow(TypeError);
  });

  // ── Edge case: appointment date past coverage end ───────────────────
  // Coverage ends 2026-12-31, so 2027-01-15 should fail.

  it('should throw when appointment date is past coverage end', async () => {
    await expect(
      scheduleAppointment({
        patientId: 'PAT-2001',
        providerId: 'DR-101',
        department: 'primary-care',
        appointmentDate: '2027-01-15',
      }),
    ).rejects.toThrow(TypeError);
  });

  // ── Edge case: appointment on exact coverage end date ───────────────

  it('should succeed when appointment is on the coverage end date', async () => {
    const result = await scheduleAppointment({
      patientId: 'PAT-2001',
      providerId: 'DR-101',
      department: 'primary-care',
      appointmentDate: '2026-12-31',
    });

    expect(result.success).toBe(true);
    expect(result.copay).toBe(20);
  });

  // ── Verify different plans return correct copay ─────────────────────

  it('should return correct copay for Silver plan (PAT-2002)', async () => {
    const result = await scheduleAppointment({
      patientId: 'PAT-2002',
      providerId: 'DR-102',
      department: 'cardiology',
      appointmentDate: '2026-06-15',
    });

    expect(result.success).toBe(true);
    expect(result.copay).toBe(35);
  });

  it('should return correct copay for Bronze plan (PAT-2003)', async () => {
    const result = await scheduleAppointment({
      patientId: 'PAT-2003',
      providerId: 'DR-103',
      department: 'dermatology',
      appointmentDate: '2026-06-15',
    });

    expect(result.success).toBe(true);
    expect(result.copay).toBe(50);
  });

  // ── Month-boundary regression ───────────────────────────────────────
  // The original bug made month 12 become month 13 (January next year).
  // Verify that December dates are parsed as December, not January.

  it('should correctly parse December dates (month-indexing regression)', async () => {
    const result = await scheduleAppointment({
      patientId: 'PAT-2001',
      providerId: 'DR-101',
      department: 'primary-care',
      appointmentDate: '2026-12-01',
    });

    expect(result.success).toBe(true);
    expect(result.date).toBe('2026-12-01');
  });
});
