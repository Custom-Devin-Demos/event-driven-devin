/* global beforeEach, describe, expect, jest, test */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/datadog-incidents', () => ({
  declareDatadogIncident: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/services/linear', () => ({
  createLinearIssue: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { declareDatadogIncident } = require('../app/services/datadog-incidents');
const { createLinearIssue } = require('../app/services/linear');
const { Sentry } = require('../app/telemetry/sentry');
const {
  verifyIdentity,
  PAYMENT_PLANS,
  IDENTITY_VERIFICATION_PROVIDERS,
} = require('../app/services/verticals/b25c3f24');

describe('Affirm identity verification service (b25c3f24)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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

    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert.mock.calls[0][0]).toMatchObject({ customer: 'b25c3f24' });
    expect(Object.keys(createSessionAndAlert.mock.calls[0][0].extra)).not.toContain('ssnLast4');
    expect(declareDatadogIncident).toHaveBeenCalledTimes(1);
    expect(createLinearIssue).toHaveBeenCalledTimes(1);
    expect(createLinearIssue.mock.calls[0][0].assigneeId).toBe('4d616028-0c12-4ad9-b117-0661170e857e');
    expect(createLinearIssue.mock.calls[0][0].description).not.toContain('1234');
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
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
