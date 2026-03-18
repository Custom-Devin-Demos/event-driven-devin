// Mock uuid before requiring the module under test (ESM compatibility)
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock telemetry dependencies to avoid side effects in tests
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
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

describe('healthcare — scheduleAppointment', () => {
  it('should succeed for a valid patient with active coverage', async () => {
    const result = await scheduleAppointment({
      patientId: 'PAT-2001',
      providerId: 'DR-101',
      department: 'primary-care',
      appointmentDate: '2026-06-15',
    });

    expect(result.success).toBe(true);
    expect(result.patientId).toBe('PAT-2001');
    expect(result.copay).toBe(PATIENT_PLANS['PAT-2001'].copayAmount);
    expect(result.status).toBe('confirmed');
    expect(result.appointmentId).toBeDefined();
  });

  it('should return the correct copay for each patient plan', async () => {
    const resultGold = await scheduleAppointment({
      patientId: 'PAT-2001',
      providerId: 'DR-101',
      department: 'primary-care',
      appointmentDate: '2026-06-15',
    });
    expect(resultGold.copay).toBe(20);

    const resultSilver = await scheduleAppointment({
      patientId: 'PAT-2002',
      providerId: 'DR-102',
      department: 'cardiology',
      appointmentDate: '2026-06-15',
    });
    expect(resultSilver.copay).toBe(35);

    const resultBronze = await scheduleAppointment({
      patientId: 'PAT-2003',
      providerId: 'DR-103',
      department: 'dermatology',
      appointmentDate: '2026-06-15',
    });
    expect(resultBronze.copay).toBe(50);
  });

  it('should throw when patientId is not found in PATIENT_PLANS (null coverage)', async () => {
    await expect(
      scheduleAppointment({
        patientId: 'PAT-UNKNOWN',
        providerId: 'DR-101',
        department: 'primary-care',
        appointmentDate: '2026-06-15',
      })
    ).rejects.toThrow();
  });

  it('should throw when appointment date is past the coverage end date', async () => {
    await expect(
      scheduleAppointment({
        patientId: 'PAT-2001',
        providerId: 'DR-101',
        department: 'primary-care',
        appointmentDate: '2027-06-15',
      })
    ).rejects.toThrow();
  });

  it('should include provider name when provider is found', async () => {
    const result = await scheduleAppointment({
      patientId: 'PAT-2001',
      providerId: 'DR-101',
      department: 'primary-care',
      appointmentDate: '2026-06-15',
    });
    expect(result.provider).toBe('Dr. Sarah Kim');
  });

  it('should fall back to providerId when provider is not found', async () => {
    const result = await scheduleAppointment({
      patientId: 'PAT-2001',
      providerId: 'DR-999',
      department: 'primary-care',
      appointmentDate: '2026-06-15',
    });
    expect(result.provider).toBe('DR-999');
  });
});
