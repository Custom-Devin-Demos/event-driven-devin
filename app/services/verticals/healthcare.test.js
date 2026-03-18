jest.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }));
const { scheduleAppointment, PATIENT_PLANS } = require('./healthcare');

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

describe('scheduleAppointment', () => {
  it('should successfully schedule an appointment for a valid patient within coverage', async () => {
    const result = await scheduleAppointment({
      patientId: 'PAT-2001',
      providerId: 'DR-101',
      department: 'primary-care',
      appointmentDate: '2026-12-15',
    });

    expect(result.success).toBe(true);
    expect(result.copay).toBe(20);
    expect(result.patientId).toBe('PAT-2001');
    expect(result.status).toBe('confirmed');
  });

  it('should return the correct copay amount from the patient plan', async () => {
    const result = await scheduleAppointment({
      patientId: 'PAT-2002',
      providerId: 'DR-102',
      department: 'cardiology',
      appointmentDate: '2026-06-15',
    });

    expect(result.success).toBe(true);
    expect(result.copay).toBe(35);
  });

  it('should correctly parse the appointment date with 0-indexed month adjustment', async () => {
    // December (month 12) should parse as December, not January of the next year
    const result = await scheduleAppointment({
      patientId: 'PAT-2001',
      providerId: 'DR-101',
      department: 'primary-care',
      appointmentDate: '2026-12-15',
    });

    expect(result.success).toBe(true);
    expect(result.date).toBe('2026-12-15');
  });

  it('should throw when patient ID is not found in PATIENT_PLANS', async () => {
    await expect(
      scheduleAppointment({
        patientId: 'PAT-INVALID',
        providerId: 'DR-101',
        department: 'primary-care',
        appointmentDate: '2026-06-15',
      }),
    ).rejects.toThrow();
  });

  it('should throw when appointment date is beyond coverage end date', async () => {
    await expect(
      scheduleAppointment({
        patientId: 'PAT-2001',
        providerId: 'DR-101',
        department: 'primary-care',
        appointmentDate: '2027-06-15',
      }),
    ).rejects.toThrow();
  });

  it('should use the correct property name coverageEnd from PATIENT_PLANS', () => {
    // Verify that PATIENT_PLANS entries have coverageEnd (not coverageEndDate)
    for (const [patientId, plan] of Object.entries(PATIENT_PLANS)) {
      expect(plan).toHaveProperty('coverageEnd');
      expect(plan).toHaveProperty('copayAmount');
      expect(new Date(plan.coverageEnd).getTime()).not.toBeNaN();
    }
  });
});
