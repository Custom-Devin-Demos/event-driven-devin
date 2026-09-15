/* global beforeEach, describe, expect, jest, test */

const { setImmediate } = require('timers');

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { Sentry } = require('../app/telemetry/sentry');
const {
  releaseBatch,
  BATCH,
  COMPANIES,
  getBatchCompanies,
} = require('../app/services/verticals/f8555891');

describe('Gusto payroll batch release service (f8555891)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  async function flushAsyncWork() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  test('releases the batch when the Minnesota employer is excluded', async () => {
    const result = await releaseBatch({
      batchId: BATCH.id,
      companyIds: COMPANIES.filter((company) => !company.workStates.includes('MN')).map((company) => company.id),
    });

    expect(result.status).toBe('released');
    expect(result.companyCount).toBe(4);
    expect(result.achFileId).toMatch(/^ACH-[0-9A-F]{8}$/);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('alerts when the full batch cannot resolve Minnesota payroll programs', async () => {
    await expect(releaseBatch({ batchId: BATCH.id })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({
      customer: 'f8555891',
      service: 'customer-f8555891-payroll',
      extra: { batchId: BATCH.id, companyId: 'CO-51177' },
    });
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(declareDatadogIncident.mock.calls[0][0]).toMatchObject({
      title: 'Payroll batch release failing for Minnesota employers',
      service: 'customer-f8555891-payroll',
    });
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags.state).toBe('MN');
  });

  test('rejects an unknown batch without alerting', async () => {
    await expect(releaseBatch({ batchId: 'PB-0000' })).rejects.toMatchObject({ code: 'UNKNOWN_BATCH', statusCode: 400 });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('dashboard listing tolerates the unregistered state', () => {
    const companies = getBatchCompanies();
    expect(companies).toHaveLength(COMPANIES.length);
    expect(companies.find((company) => company.id === 'CO-51177').employerContributions).toBe(0);
  });
});
