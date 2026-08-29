const {
  submitEngagement,
  PRACTICES,
  COVERAGE_PROFILES,
  ENGAGEMENT_DESKS,
  resolveCoverageProfile,
  buildEngagementLane,
  resolveMandateTier,
  buildFeeIndication,
} = require('../app/services/verticals/fa4d1e65');

describe('Investment banking engagement inquiry service (fa4d1e65)', () => {
  test('domestic strategic advisory inquiry returns a fee indication', async () => {
    const brief = await submitEngagement({ practice: 'strategic_advisory', region: 'US' });

    expect(brief.success).toBe(true);
    expect(brief.practice).toBe('Strategic Advisory');
    expect(brief.feeIndication.lane).toBe('advisory-domestic');
    expect(brief.feeIndication.deskLabel).toBe(ENGAGEMENT_DESKS['advisory-domestic'].label);
    expect(brief.feeIndication.currency).toBe('usd');
  });

  test('cross-border capital markets inquiry resolves the cross-border desk', async () => {
    const brief = await submitEngagement({
      practice: 'equity_capital_markets',
      region: 'GB',
      transactionValueUsd: 2000000000,
    });

    expect(brief.feeIndication.lane).toBe('capital_markets-cross-border');
    expect(brief.feeIndication.deskLabel).toBe(ENGAGEMENT_DESKS['capital_markets-cross-border'].label);
    expect(brief.feeIndication.mandateTier).toBe('large-cap');
  });

  test('every practice and coverage pairing maps to a published desk', () => {
    Object.values(PRACTICES).forEach((practice) => {
      Object.keys(COVERAGE_PROFILES).forEach((region) => {
        const profile = resolveCoverageProfile(region);
        const lane = buildEngagementLane(practice, profile);

        expect(ENGAGEMENT_DESKS[lane]).toBeDefined();
      });
    });
  });

  test('unknown region falls back to the US coverage profile', async () => {
    const brief = await submitEngagement({ practice: 'restructuring', region: 'ZZ' });

    expect(brief.region).toBe('americas');
    expect(brief.feeIndication.lane).toBe('advisory-domestic');
  });

  test('buildFeeIndication does not throw for an unmapped desk', () => {
    const practice = { code: 'unknown', name: 'Unknown', description: '', desk: 'unmapped' };
    const profile = COVERAGE_PROFILES.US;
    const feeIndication = buildFeeIndication(practice, profile, resolveMandateTier(undefined));

    expect(feeIndication.deskLabel).toBe(ENGAGEMENT_DESKS['advisory-domestic'].label);
    expect(feeIndication.retainerBps).toBeGreaterThan(0);
  });
});
