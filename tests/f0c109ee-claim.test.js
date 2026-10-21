/* global describe, expect, test, jest, beforeEach */

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
const { submitClaim, ValidationError } = require('../app/services/verticals/f0c109ee');
const { getCustomerConfig } = require('../config/customers');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');

const IDENTITY = {
  devinUserId: 'user-abc123',
  devinOrgId: 'org-xyz789',
  devinEmail: 'jamie@devindemos.com',
};

const DENTAL = {
  policyId: 'POL-5004',
  claimType: 'dental',
  amount: 420,
  description: 'Two crowns and an exam at an in-network dentist',
  serviceDate: '2026-10-01',
};

describe('f0c109ee claim submission', () => {
  beforeEach(() => jest.clearAllMocks());

  test('rejects unknown coverage without alerting', async () => {
    await expect(submitClaim({ ...DENTAL, policyId: 'POL-0000' })).rejects.toBeInstanceOf(ValidationError);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('a dental claim fails and raises an alert tagged with the customer and hub identity', async () => {
    await expect(submitClaim({ ...DENTAL, ...IDENTITY })).rejects.toThrow(TypeError);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).toHaveBeenCalledTimes(1);
    const alert = createSessionAndAlert.mock.calls[0][0];
    expect(alert.customer).toBe('f0c109ee');
    expect(alert.devinUserId).toBe(IDENTITY.devinUserId);
    expect(alert.devinOrgId).toBe(IDENTITY.devinOrgId);
    expect(alert.devinEmail).toBe(IDENTITY.devinEmail);
    expect(alert.culprit).toContain('app/services/verticals/f0c109ee.js');
  });

  test('is registered as a customer and suppressed from the Sentry webhook fallback', () => {
    expect(getCustomerConfig('f0c109ee').customer).toBe('f0c109ee');
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/f0c109ee.js — calculateBenefit', tags: [] })).toBe(true);
  });
});
