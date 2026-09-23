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
const { releaseDisbursement } = require('../app/services/verticals/1d7f8961');

describe('business-center payroll disbursement (1d7f8961)', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('off-cycle bonus run fails with a TypeError and raises an alert', async () => {
    await expect(releaseDisbursement({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 4875600,
      runType: 'off-cycle-bonus',
      employeeCount: 1248,
    })).rejects.toThrow(TypeError);

    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('1d7f8961');
    expect(alert.errorType).toBe('TypeError');
    expect(alert.culprit).toContain('buildWpsSalaryFile');
  });

  test('monthly salary run releases and files the WPS salary file', async () => {
    const result = await releaseDisbursement({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 4875600,
      runType: 'monthly-salary',
      employeeCount: 1248,
    });

    expect(result.success).toBe(true);
    expect(result.wpsFile.fileFormat).toBe('WPS-SIF-2.1');
    expect(result.wpsFile.salaryRecords).toBe(1248);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('validation failures return 400s without raising an alert', async () => {
    await expect(releaseDisbursement({
      fromAccount: 'ACCT-9999',
      amount: 100,
      runType: 'monthly-salary',
    })).rejects.toMatchObject({ statusCode: 400, code: 'FUNDING_ACCOUNT_NOT_FOUND' });

    await expect(releaseDisbursement({
      fromAccount: 'ACCT-1001',
      amount: 0,
      runType: 'monthly-salary',
    })).rejects.toMatchObject({ statusCode: 400, code: 'INVALID_PAYROLL_AMOUNT' });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });
});
