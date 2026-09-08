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
  verifyIdentity,
  PAYMENT_PLANS,
  IDENTITY_VERIFICATION_PROVIDERS,
  REMEDIATION_DIRECTIVE,
} = require('../app/services/verticals/b25c3f24');

describe('Affirm identity verification service (b25c3f24)', () => {
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

  test('approves a six-month plan with short-term verification', async () => {
    const result = await verifyIdentity({
      planId: 'plan-6',
      ssnLast4: '1234',
      orderTotal: 1944.39,
    });

    expect(result.status).toBe('approved');
    expect(result.identityCheck.tier).toBe('short-term');
    expect(result.identityCheck.verified).toBe(true);
    expect(result.loanId).toMatch(/^AFM-[0-9A-F]{8}$/);
  });

  test('requires knowledge-based authentication for a 24-month plan', async () => {
    const result = await verifyIdentity({
      planId: 'plan-24',
      ssnLast4: '1234',
      orderTotal: 1944.39,
    });

    expect(result.identityCheck.tier).toBe('extended');
    expect(result.identityCheck.kbaRequired).toBe(true);
  });

  test('alerts when the default twelve-month plan cannot resolve its provider', async () => {
    await expect(verifyIdentity({
      planId: 'plan-12',
      ssnLast4: '1234',
      orderTotal: 1944.39,
    })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({ customer: 'b25c3f24' });
    expect(Object.keys(createSessionAndAlert.mock.calls[0][0].extra)).not.toContain('ssnLast4');
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(createLinearIssue).toHaveBeenCalledTimes(1);
    expect(createLinearIssue.mock.calls[0][0].assigneeId).toBe('4d616028-0c12-4ad9-b117-0661170e857e');
    expect(createLinearIssue.mock.calls[0][0].description).not.toContain('1234');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
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

    await expect(verifyIdentity({
      planId: 'plan-12',
      ssnLast4: '1234',
      orderTotal: 1944.39,
    })).rejects.toThrow(TypeError);
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
    expect(addLinearComment.mock.calls[0][0].body).not.toContain('1234');
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

    await expect(verifyIdentity({
      planId: 'plan-12',
      ssnLast4: '1234',
      orderTotal: 1944.39,
    })).rejects.toThrow(TypeError);
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

    await expect(verifyIdentity({
      planId: 'plan-12',
      ssnLast4: '1234',
      orderTotal: 1944.39,
    })).rejects.toThrow(TypeError);
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

    await expect(verifyIdentity({
      planId: 'plan-12',
      ssnLast4: '1234',
      orderTotal: 1944.39,
    })).rejects.toThrow(TypeError);
    await flushAsyncWork();

    expect(createSessionAndAlert.mock.calls[0][0].promptAppendix).toBe(REMEDIATION_DIRECTIVE);
    expect(addLinearComment).not.toHaveBeenCalled();
    expect(updateLinearIssueState).not.toHaveBeenCalled();
  });

  test('rejects an invalid SSN last four without alerting', async () => {
    await expect(verifyIdentity({
      planId: 'plan-6',
      ssnLast4: '12',
      orderTotal: 1944.39,
    })).rejects.toMatchObject({
      name: 'ValidationError',
      statusCode: 400,
      code: 'INVALID_SSN_LAST4',
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(declareDatadogIncident).not.toHaveBeenCalled();
  });

  test('defines the short-term and extended verification provider tiers', () => {
    expect(IDENTITY_VERIFICATION_PROVIDERS).toHaveProperty('short-term');
    expect(IDENTITY_VERIFICATION_PROVIDERS).toHaveProperty('extended');
    expect(PAYMENT_PLANS).toHaveLength(3);
  });
});
