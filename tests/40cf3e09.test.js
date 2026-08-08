const {
  processAccountActivation,
  buildActivationPackage,
  resolveRegion,
  resolveTierTerms,
  ACCOUNT_REGIONS,
  TIER_TERMS,
  DEFAULT_PLAN_TIER,
} = require('../app/services/verticals/40cf3e09');

describe('Nimbus account activation service (40cf3e09)', () => {
  test('activates a free-tier account without throwing (regression: NODE-EXPRESS-49)', async () => {
    const result = await processAccountActivation({ region: 'us-east-1', planTier: 'free' });

    expect(result.planTier).toBe('free');
    expect(result.activation.accountRegion).toBe(ACCOUNT_REGIONS['us-east-1'].region);
    expect(result.activation.totalCredits).toBe(
      TIER_TERMS.free.baseCredits + TIER_TERMS.free.bonusCredits,
    );
    expect(result.activation.expiresInMonths).toBe(TIER_TERMS.free.windowMonths);
  });

  test('grants tier credits for a paid tier', async () => {
    const result = await processAccountActivation({ region: 'eu-west-1', planTier: 'pro' });

    expect(result.activation.totalCredits).toBe(
      TIER_TERMS.pro.baseCredits + TIER_TERMS.pro.bonusCredits,
    );
    expect(result.activation.zone).toBe(ACCOUNT_REGIONS['eu-west-1'].zone);
  });

  test('falls back to the default tier for missing or unknown plan tiers', () => {
    const regionInfo = resolveRegion('us-west-2');

    for (const planTier of [undefined, null, '', 'platinum', 'FREE']) {
      const activation = buildActivationPackage(regionInfo, planTier);
      expect(activation.totalCredits).toBe(
        TIER_TERMS[DEFAULT_PLAN_TIER].baseCredits + TIER_TERMS[DEFAULT_PLAN_TIER].bonusCredits,
      );
    }
  });

  test('falls back to the default region for missing or unknown regions', async () => {
    const defaultRegion = ACCOUNT_REGIONS['us-east-1'];

    expect(resolveRegion('mars-north-1')).toEqual(defaultRegion);
    expect(resolveRegion(undefined)).toEqual(defaultRegion);

    const result = await processAccountActivation({ region: 'mars-north-1', planTier: 'starter' });
    expect(result.activation.accountRegion).toBe(defaultRegion.region);
  });

  test('every plan tier defines complete credit terms', () => {
    for (const terms of Object.values(TIER_TERMS)) {
      expect(typeof terms.baseCredits).toBe('number');
      expect(typeof terms.bonusCredits).toBe('number');
      expect(typeof terms.windowMonths).toBe('number');
    }
    expect(resolveTierTerms(DEFAULT_PLAN_TIER)).toBe(TIER_TERMS[DEFAULT_PLAN_TIER]);
  });
});
