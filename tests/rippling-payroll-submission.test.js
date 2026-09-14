/* global beforeEach, describe, expect, jest, test */

const { setImmediate } = require('timers');

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/linear', () => ({
  createLinearIssue: jest.fn().mockResolvedValue(null),
  addLinearComment: jest.fn().mockResolvedValue(null),
  updateLinearIssueState: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const {
  createLinearIssue,
  addLinearComment,
  updateLinearIssueState,
} = require('../app/services/linear');
const { Sentry } = require('../app/telemetry/sentry');
const {
  submitPayRun,
  PAY_RUN,
  EMPLOYEES,
  STATE_WITHHOLDING_POLICIES,
  REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/a7fb8819');

describe('Rippling payroll submission service (a7fb8819)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    createLinearIssue.mockResolvedValue(null);
    createSessionAndAlert.mockResolvedValue(null);
    addLinearComment.mockResolvedValue(null);
    updateLinearIssueState.mockResolvedValue(null);
  });

  async function flushAsyncWork() {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
  }

  test('submits a pay run successfully when Colorado employee is excluded', async () => {
    const result = await submitPayRun({
      payRunId: PAY_RUN.id,
      employeeIds: EMPLOYEES.filter((employee) => employee.workState !== 'CO').map((employee) => employee.id),
    });

    expect(result.status).toBe('submitted');
    expect(result.employeeCount).toBe(5);
    expect(result.totalGross).toBe(35000);
    expect(result.confirmation).toMatch(/^RPL-[0-9A-F]{8}$/);
    expect(result.employees).toHaveLength(5);
  });

  test('alerts when the full pay run cannot resolve Colorado withholding policy', async () => {
    await expect(submitPayRun({ payRunId: PAY_RUN.id })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({ customer: 'a7fb8819' });
    expect(createSessionAndAlert.mock.calls[0][0].extra).toMatchObject({ employeeId: 'EMP-1006' });
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(declareDatadogIncident.mock.calls[0][0]).toMatchObject({
      title: 'Rippling payroll submission failing for Colorado employees',
      service: 'customer-a7fb8819-payroll',
    });
    expect(createLinearIssue).toHaveBeenCalledTimes(1);
    expect(createLinearIssue.mock.calls[0][0].assigneeId).toBe('4d616028-0c12-4ad9-b117-0661170e857e');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(Sentry.captureException.mock.calls[0][1].tags).toMatchObject({ state: 'CO' });
  });

  test('links the Devin session and directs the ticket lifecycle when Linear creates an issue', async () => {
    createLinearIssue.mockResolvedValue({
      id: 'iss_1',
      identifier: 'COG-9999',
      url: 'https://linear.app/cog-gtm/issue/COG-9999',
    });
    createSessionAndAlert.mockResolvedValue({
      triggered: true,
      throttled: false,
      threadTs: '1.2',
      session: {
        sessionId: 'devin-abc',
        url: 'https://app.devin.ai/sessions/abc',
      },
    });

    await expect(submitPayRun({ payRunId: PAY_RUN.id })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.promptAppendix).toContain('COG-9999');
    expect(alert.promptAppendix).toContain('The app moves the ticket to In Progress and comments your session link right after your session is created');
    expect(alert.promptAppendix).toContain('In Review');
    expect(alert.promptAppendix).toContain('Do NOT move the ticket to Done');
    expect(addLinearComment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: 'iss_1',
      body: expect.stringContaining('https://app.devin.ai/sessions/abc'),
    }));
    expect(updateLinearIssueState).toHaveBeenCalledWith({
      issueId: 'iss_1',
      stateId: '99c9b96f-39b3-4a09-9112-53c054f3dbab',
    });
  });

  test('still comments when moving the Linear issue to In Progress fails', async () => {
    createLinearIssue.mockResolvedValue({
      id: 'iss_1',
      identifier: 'COG-9999',
      url: 'https://linear.app/cog-gtm/issue/COG-9999',
    });
    createSessionAndAlert.mockResolvedValue({
      triggered: true,
      throttled: false,
      threadTs: '1.2',
      session: {
        sessionId: 'devin-abc',
        url: 'https://app.devin.ai/sessions/abc',
      },
    });
    updateLinearIssueState.mockRejectedValueOnce(new Error('boom'));

    await expect(submitPayRun({ payRunId: PAY_RUN.id })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    expect(updateLinearIssueState).toHaveBeenCalledWith({
      issueId: 'iss_1',
      stateId: '99c9b96f-39b3-4a09-9112-53c054f3dbab',
    });
    expect(addLinearComment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: 'iss_1',
      body: expect.stringContaining('https://app.devin.ai/sessions/abc'),
    }));
  });

  test('still moves the Linear issue to In Progress when commenting fails', async () => {
    createLinearIssue.mockResolvedValue({
      id: 'iss_1',
      identifier: 'COG-9999',
      url: 'https://linear.app/cog-gtm/issue/COG-9999',
    });
    createSessionAndAlert.mockResolvedValue({
      triggered: true,
      throttled: false,
      threadTs: '1.2',
      session: {
        sessionId: 'devin-abc',
        url: 'https://app.devin.ai/sessions/abc',
      },
    });
    addLinearComment.mockRejectedValueOnce(new Error('boom'));

    await expect(submitPayRun({ payRunId: PAY_RUN.id })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    expect(updateLinearIssueState).toHaveBeenCalledWith({
      issueId: 'iss_1',
      stateId: '99c9b96f-39b3-4a09-9112-53c054f3dbab',
    });
    expect(addLinearComment).toHaveBeenCalledWith(expect.objectContaining({
      issueId: 'iss_1',
      body: expect.stringContaining('https://app.devin.ai/sessions/abc'),
    }));
  });

  test('uses the base remediation directive and skips Linear follow-up without an issue', async () => {
    createSessionAndAlert.mockResolvedValue({
      triggered: true,
      throttled: false,
      threadTs: '1.2',
      session: {
        sessionId: 'devin-abc',
        url: 'https://app.devin.ai/sessions/abc',
      },
    });

    await expect(submitPayRun({ payRunId: PAY_RUN.id })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    expect(createSessionAndAlert.mock.calls[0][0].promptAppendix).toBe(REMEDIATION_DIRECTIVE);
    expect(addLinearComment).not.toHaveBeenCalled();
    expect(updateLinearIssueState).not.toHaveBeenCalled();
  });

  test('rejects an unknown pay run without alerting', async () => {
    await expect(submitPayRun({ payRunId: 'PR-unknown' })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
      code: 'UNKNOWN_PAY_RUN',
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });

  test('rejects an empty pay run without alerting', async () => {
    await expect(submitPayRun({
      payRunId: PAY_RUN.id,
      employeeIds: [],
    })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
      code: 'EMPTY_PAY_RUN',
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });

  test('defines withholding policies for the supported states and leaves Colorado missing', () => {
    expect(STATE_WITHHOLDING_POLICIES).toHaveProperty('CA');
    expect(STATE_WITHHOLDING_POLICIES).toHaveProperty('NY');
    expect(STATE_WITHHOLDING_POLICIES).toHaveProperty('TX');
    expect(STATE_WITHHOLDING_POLICIES).toHaveProperty('WA');
    expect(STATE_WITHHOLDING_POLICIES.CO).toBeUndefined();
    expect(STATE_WITHHOLDING_POLICIES.TX.withholdingRate).toBe(0);
    expect(STATE_WITHHOLDING_POLICIES.WA.withholdingRate).toBe(0);
  });
});
