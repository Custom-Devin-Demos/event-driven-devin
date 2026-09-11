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
const { incrementMetric } = require('../app/telemetry/datadog');
const { estimateCopay } = require('../app/services/verticals/fcf0f903');

describe('patient access copay-estimate path (fcf0f903)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    incrementMetric.mockClear();
  });

  test('a Standard patient is quoted the $150 standard copay', async () => {
    const result = await estimateCopay({
      patientId: 'pat-grace-2043',
      therapyId: 'thx-veltrixa',
      fills: 1,
    });

    expect(result.status).toBe('quoted');
    expect(result.tier).toBe('Standard');
    expect(result.patientCopay).toBe(150);
    expect(result.assistanceEligible).toBe(false);
    expect(result.programPays).toBe(0);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('a Specialty Commercial patient is silently quoted Standard under the planted fallback', async () => {
    const result = await estimateCopay({
      patientId: 'pat-elena-4417',
      therapyId: 'thx-veltrixa',
      fills: 3,
    });

    expect(result.status).toBe('quoted');
    expect(result.tier).toBe('Standard');
    expect(result.patientCopay).toBe(150);
    expect(result.patientPays).toBe(450);
    expect(result.assistanceEligible).toBe(false);
    expect(incrementMetric).toHaveBeenCalledWith('copay_estimate.quoted', expect.objectContaining({
      tier: 'Standard',
      patientId: 'pat-elena-4417',
    }));
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('a Foundation Assistance patient is silently quoted Standard under the planted fallback', async () => {
    const result = await estimateCopay({
      patientId: 'pat-daniel-8820',
      therapyId: 'thx-corvalis',
    });

    expect(result.tier).toBe('Standard');
    expect(result.patientCopay).toBe(150);
    expect(result.assistanceEligible).toBe(false);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([
    ['unknown patient', { patientId: 'missing', therapyId: 'thx-veltrixa' }, 'PATIENT_NOT_FOUND'],
    ['unknown therapy', { patientId: 'pat-grace-2043', therapyId: 'missing' }, 'THERAPY_NOT_SUPPORTED'],
  ])('%s is rejected as a validation error', async (_caseName, data, code) => {
    await expect(estimateCopay(data)).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
      code,
    });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
