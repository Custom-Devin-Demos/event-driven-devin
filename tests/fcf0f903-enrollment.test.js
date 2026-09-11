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
const { submitEnrollment } = require('../app/services/verticals/fcf0f903');

describe('patient access enrollment path (fcf0f903)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('enrollment throws a TypeError while resolving the coverage tier and raises an alert', async () => {
    await expect(submitEnrollment({
      patientId: 'pat-elena-4417',
      therapyId: 'thx-veltrixa',
      consent: true,
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
      devinEmail: 'demo@example.com',
    })).rejects.toMatchObject({
      name: 'TypeError',
      message: "Cannot read properties of undefined (reading 'assistanceEligible')",
    });

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: 'fcf0f903',
      service: 'customer-fcf0f903-patient-access',
      errorType: 'TypeError',
      devinUserId: 'user-1',
      devinOrgId: 'org-1',
      devinEmail: 'demo@example.com',
      promptAppendix: expect.stringContaining('Patient Access Platform Engineering'),
    }));
  });

  test('every patient record hits the same TypeError regardless of tier', async () => {
    for (const patientId of ['pat-grace-2043', 'pat-daniel-8820']) {
      await expect(submitEnrollment({
        patientId,
        therapyId: 'thx-nuvexa',
        consent: true,
      })).rejects.toMatchObject({ name: 'TypeError' });
    }
    expect(createSessionAndAlert).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['unknown patient', { patientId: 'missing', therapyId: 'thx-veltrixa', consent: true }, 'PATIENT_NOT_FOUND'],
    ['unknown therapy', { patientId: 'pat-elena-4417', therapyId: 'missing', consent: true }, 'THERAPY_NOT_SUPPORTED'],
    ['missing consent', { patientId: 'pat-elena-4417', therapyId: 'thx-veltrixa', consent: false }, 'CONSENT_REQUIRED'],
  ])('%s is rejected as a validation error without an alert', async (_caseName, data, code) => {
    await expect(submitEnrollment(data)).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
      code,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
