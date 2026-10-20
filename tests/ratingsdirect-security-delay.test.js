/* global beforeEach, describe, expect, jest, test */
jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({ triggered: true }),
}));
jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));

const { Sentry } = require('../app/telemetry/sentry');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { isInstantPathEvent } = require('../app/routes/sentry-webhook');
const {
  generateScorecard,
} = require('../app/services/verticals/ratingsdirect');

const failingScorecard = {
  issuerId: 'SPG-ISS-4471028',
  businessRiskProfile: 'satisfactory',
  financialRiskProfile: 'significant',
  countryRiskScore: 2,
  industryRiskScore: 3,
  ffoToDebtPercent: 14.8,
  debtToEbitda: 4.6,
  ebitdaInterestCoverage: 3.4,
  liquidityAssessment: 'adequate',
  comparableRatingsAdjustment: 0,
  analystNotes: 'Committee package ready.',
  criteriaConfirmed: true,
  channel: 'web',
  devinUserId: 'user-123',
  devinOrgId: 'org-123',
  devinEmail: 'presenter@example.com',
};

describe('RatingsDirect security remediation timing', () => {
  beforeEach(() => {
    createSessionAndAlert.mockClear();
    Sentry.captureException.mockClear();
  });

  test('delays the separate remediation flow by one minute', async () => {
    await expect(generateScorecard(failingScorecard)).rejects.toThrow(
      "Cannot read properties of undefined (reading 'anchorMatrix')",
    );

    expect(createSessionAndAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'ratingsdirect',
        vulnerablePrDelayMs: 60000,
        devinUserId: 'user-123',
        devinOrgId: 'org-123',
        devinEmail: 'presenter@example.com',
      }),
    );
  });

  test('does not start an alert or remediation flow for a healthy issuer', async () => {
    await expect(generateScorecard({
      ...failingScorecard,
      issuerId: 'SPG-ISS-8820416',
    })).resolves.toMatchObject({
      success: true,
      issuerId: 'SPG-ISS-8820416',
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('tags the Sentry event so the issue webhook does not alert a second time', async () => {
    await expect(generateScorecard(failingScorecard)).rejects.toThrow();

    expect(Sentry.captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ alert_path: 'instant' }) }),
    );
  });

  test('webhook treats RatingsDirect events as already alerted (tagged and tagless shapes)', () => {
    expect(isInstantPathEvent({
      culprit: 'app/services/verticals/ratingsdirect.js — calculateAnchorScore',
      tags: [],
    })).toBe(true);
    expect(isInstantPathEvent({
      culprit: 'calculateAnchorScore(app.services.verticals.ratingsdirect)',
      tags: [],
    })).toBe(true);
    expect(isInstantPathEvent({
      culprit: '',
      tags: [{ key: 'alert_path', value: 'instant' }, { key: 'route', value: '/api/ratingsdirect/scorecard' }],
    })).toBe(true);
  });
});
