const {
  submitEngagement,
  buildEngagementLane,
  buildFeeIndication,
  resolveCoverageProfile,
  resolveMandateTier,
  PRACTICES,
  COVERAGE_PROFILES,
  ENGAGEMENT_DESKS,
} = require('../app/services/verticals/fa4d1e65');

describe('Investment banking engagement inquiry service (fa4d1e65)', () => {
  test('returns an engagement brief with a fee indication for a US strategic advisory inquiry', async () => {
    const brief = await submitEngagement({
      practice: 'strategic_advisory',
      region: 'US',
      transactionValueUsd: 250000000,
    });

    expect(brief.success).toBe(true);
    expect(brief.practice).toBe('Strategic Advisory');
    expect(brief.feeIndication.lane).toBe('advisory-domestic');
    expect(brief.feeIndication.deskLabel).toBe('Domestic strategic advisory desk');
    expect(brief.feeIndication.currency).toBe('usd');
    expect(brief.feeIndication.mandateTier).toBe('mid-market');
  });

  test('quotes the cross-border desk for a non-US coverage region', async () => {
    const brief = await submitEngagement({
      practice: 'equity_capital_markets',
      region: 'GB',
      transactionValueUsd: 8000000000,
    });

    expect(brief.feeIndication.lane).toBe('capital_markets-cross-border');
    expect(brief.feeIndication.deskLabel).toBe('Cross-border capital markets desk');
    expect(brief.feeIndication.currency).toBe('gbp');
    expect(brief.feeIndication.seniorCoverage).toBe('firm-leadership');
  });

  test('every practice and coverage pairing resolves to a configured desk', () => {
    for (const practice of Object.values(PRACTICES)) {
      for (const region of Object.keys(COVERAGE_PROFILES)) {
        const profile = resolveCoverageProfile(region);
        const lane = buildEngagementLane(practice, profile);

        expect(ENGAGEMENT_DESKS[lane]).toBeDefined();
        expect(buildFeeIndication(practice, profile, resolveMandateTier(100000000)).deskLabel)
          .toBe(ENGAGEMENT_DESKS[lane].label);
      }
    }
  });

  test('falls back to defaults for an unknown practice, region and missing transaction value', async () => {
    const brief = await submitEngagement({ practice: 'not-a-practice', region: 'ZZ' });

    expect(brief.practice).toBe('Strategic Advisory');
    expect(brief.region).toBe('americas');
    expect(brief.feeIndication.lane).toBe('advisory-domestic');
    expect(brief.feeIndication.mandateTier).toBe('mid-market');
  });

  test('raises an explicit error instead of a TypeError when no desk is configured for a lane', () => {
    const unknownPractice = { code: 'unknown', name: 'Unknown', description: '', desk: 'unknown_desk' };
    const profile = resolveCoverageProfile('US');

    expect(() => buildFeeIndication(unknownPractice, profile, resolveMandateTier(1)))
      .toThrow(/No engagement desk configured for lane "unknown_desk-domestic"/);
  });
});
