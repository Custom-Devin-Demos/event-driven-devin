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
const { estimatePharmacyCost } = require('../app/services/verticals/86a0a4f9');

describe('Lilly LillyDirect pharmacy cost estimate (86a0a4f9)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
    incrementMetric.mockClear();
  });

  test('a commercially covered patient is quoted the $25 savings card price', async () => {
    const result = await estimatePharmacyCost({ patientId: 'LD70419283', medicationId: 'zepbound-pen-5' });

    expect(result.status).toBe('quoted');
    expect(result.coverageType).toBe('commercial_covered');
    expect(result.patientPays).toBe(25);
    expect(result.savingsCardApplied).toBe(true);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('a Medicare Part D patient is silently quoted the $25 savings card price under the planted commercial default', async () => {
    const result = await estimatePharmacyCost({ patientId: 'LD70633107', medicationId: 'mounjaro-pen-5' });

    expect(result.status).toBe('quoted');
    expect(result.coverageType).toBe('commercial_covered');
    expect(result.patientPays).toBe(25);
    expect(result.savingsCardApplied).toBe(true);
    expect(incrementMetric).toHaveBeenCalledWith('cost_estimate.quoted', expect.objectContaining({
      program: 'commercial_covered',
      patientId: 'LD70633107',
    }));
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('a self-pay patient is silently quoted the savings card price instead of the Self Pay price', async () => {
    const result = await estimatePharmacyCost({ patientId: 'LD70748566', medicationId: 'zepbound-vial-5' });

    expect(result.coverageType).toBe('commercial_covered');
    expect(result.patientPays).toBe(25);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a commercially uncovered patient is silently quoted the covered price', async () => {
    const result = await estimatePharmacyCost({ patientId: 'LD70522841', medicationId: 'zepbound-pen-5' });

    expect(result.coverageType).toBe('commercial_covered');
    expect(result.patientPays).toBe(25);
  });

  test.each([
    ['unknown patient', { patientId: 'LD00000000', medicationId: 'zepbound-pen-5' }, 'PatientNotFoundError', 404, 'PATIENT_NOT_FOUND'],
    ['unknown medication', { patientId: 'LD70419283', medicationId: 'humalog' }, 'ValidationError', 400, 'UNKNOWN_MEDICATION'],
  ])('%s is rejected without paging anyone', async (_caseName, data, name, statusCode, code) => {
    await expect(estimatePharmacyCost(data)).rejects.toMatchObject({ name, statusCode, code });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });
});
