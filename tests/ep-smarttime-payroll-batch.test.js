/* global beforeEach, describe, expect, jest, test */
jest.mock('../app/services/devin-session', () => ({ createSessionAndAlert: jest.fn().mockResolvedValue(null) }));
jest.mock('../app/services/datadog-incidents', () => ({ declareDatadogIncident: jest.fn().mockResolvedValue(null) }));
jest.mock('../app/telemetry/sentry', () => ({ Sentry: { captureException: jest.fn() } }));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { PRODUCTION, TIMECARDS, REMEDIATION_DIRECTIVE, sendTimecardsToPayroll } = require('../app/services/verticals/02a5e918');

describe('Entertainment Partners SmartTime send to payroll (02a5e918)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('sends the batch when the Local 600 camera timecard is excluded', async () => {
    const result = await sendTimecardsToPayroll({ batchId: PRODUCTION.payrollBatchId, timecardIds: TIMECARDS.filter((t) => t.union !== 'IATSE-600').map((t) => t.id) });
    expect(result.status).toBe('sent_to_payroll');
    expect(result.timecardCount).toBe(5);
    expect(result.totalLaborCost).toBeGreaterThan(result.totalGross);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('full batch fails and starts a Devin session for the payroll incident', async () => {
    await expect(sendTimecardsToPayroll({ batchId: PRODUCTION.payrollBatchId, devinEmail: 'presenter@cognition.ai' })).rejects.toMatchObject({ name: 'TypeError', code: 'PAYROLL_BATCH_FAILED', statusCode: 500 });
    expect(declareDatadogIncident).toHaveBeenCalledWith(expect.objectContaining({ service: 'customer-02a5e918-smarttime', severity: 'SEV-2' }));
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({
      customer: '02a5e918', devinEmail: 'presenter@cognition.ai', devinOrgId: undefined, promptAppendix: REMEDIATION_DIRECTIVE,
    }));
  });

  test.each([
    [{ batchId: 'TB-OLD' }, 'UNKNOWN_TIMECARD_BATCH'],
    [{ batchId: PRODUCTION.payrollBatchId, timecardIds: 'TC-91841' }, 'INVALID_TIMECARD_SELECTION'],
    [{ batchId: PRODUCTION.payrollBatchId, timecardIds: [] }, 'EMPTY_TIMECARD_BATCH'],
    [{ batchId: PRODUCTION.payrollBatchId, timecardIds: ['TC-00000'] }, 'UNKNOWN_TIMECARD'],
  ])('rejects invalid input without alerting', async (input, code) => {
    await expect(sendTimecardsToPayroll(input)).rejects.toMatchObject({ statusCode: 400, code });
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('remediation prompt reads like a production incident', () => {
    expect(REMEDIATION_DIRECTIVE).not.toMatch(/simulated|planted|demo bug/i);
  });
});
