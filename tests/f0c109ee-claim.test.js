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

  test('skips the alert when the caller is over its alert budget', async () => {
    await expect(submitClaim({ ...DENTAL, ...IDENTITY }, { shouldAlert: () => false })).rejects.toThrow(TypeError);
    expect(Sentry.captureException).toHaveBeenCalledTimes(1);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('caps alerts per client IP per hour while every claim still returns 500', async () => {
    const express = require('express');
    const router = require('../app/routes/verticals/f0c109ee');
    const app = express();
    app.use(express.json());
    app.use(router);
    const server = app.listen(0);
    const { port } = server.address();
    const post = (ip) => fetch(`http://127.0.0.1:${port}/api/f0c109ee/claims`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': ip },
      body: JSON.stringify({ ...DENTAL, ...IDENTITY }),
    });
    try {
      const responses = await Promise.all(
        Array.from({ length: router.ALERT_HOURLY_CAP + 1 }, () => post('203.0.113.7')),
      );
      const statuses = responses.map((response) => response.status);
      expect(statuses.every((status) => status === 500)).toBe(true);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(router.ALERT_HOURLY_CAP);
      expect((await post('203.0.113.8')).status).toBe(500);
      expect(createSessionAndAlert).toHaveBeenCalledTimes(router.ALERT_HOURLY_CAP + 1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => { server.close(resolve); });
    }
  }, 15000);

  test('is registered as a customer and suppressed from the Sentry webhook fallback', () => {
    expect(getCustomerConfig('f0c109ee').customer).toBe('f0c109ee');
    expect(isInstantPathEvent({ culprit: 'app/services/verticals/f0c109ee.js — calculateBenefit', tags: [] })).toBe(true);
  });
});
