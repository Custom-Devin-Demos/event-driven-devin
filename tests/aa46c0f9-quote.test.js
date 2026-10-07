jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');
const {
  purchasePolicy,
  buildPolicies,
  ratePolicy,
  applyBundleEndorsements,
  resolveBundle,
  COVERAGE_PACKAGES,
  BUNDLE_OFFERS,
  STATE_FACTORS,
} = require('../app/services/verticals/aa46c0f9');

const DEFAULT_QUOTE = {
  zipCode: '06183',
  state: 'CT',
  vehicles: [{ year: 2024, make: 'Toyota', model: 'RAV4 XLE' }],
  drivers: [{ name: 'Primary driver', age: 42 }],
  coveragePackage: 'standard',
  paymentPlan: 'monthly',
};

describe('Travelers auto quote purchase (aa46c0f9)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each(['ZZ', 'constructor'])('rejects invalid state %s without telemetry or a Devin session', async (state) => {
    await expect(purchasePolicy({ ...DEFAULT_QUOTE, bundle: null, state }))
      .rejects.toMatchObject({
        name: 'ValidationError',
        code: 'INVALID_STATE',
        status: 400,
      });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each(['1234', 'abcdef', '0618'])('rejects malformed ZIP %s without an alert', async (zipCode) => {
    await expect(purchasePolicy({ ...DEFAULT_QUOTE, bundle: null, zipCode }))
      .rejects.toMatchObject({
        name: 'ValidationError',
        code: 'INVALID_ZIP',
        status: 400,
      });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('rejects an empty vehicle list without an alert', async () => {
    await expect(purchasePolicy({ ...DEFAULT_QUOTE, bundle: null, vehicles: [] }))
      .rejects.toMatchObject({
        name: 'ValidationError',
        code: 'NO_VEHICLES',
        status: 400,
      });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('home bundle rejects with the planted TypeError and triggers a Devin session', async () => {
    await expect(purchasePolicy({ ...DEFAULT_QUOTE, bundle: 'home' }))
      .rejects.toThrow(/reading 'minimumPremium'/);
    await expect(purchasePolicy({ ...DEFAULT_QUOTE, bundle: 'home' }))
      .rejects.toBeInstanceOf(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: 'aa46c0f9',
        service: 'travelers-auto-quote',
        verticalLabel: 'Travelers Auto Quote & Purchase',
      }),
    );

    expect(Sentry.captureException).toHaveBeenCalled();
    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');
  });

  test('renters bundle binds with exact computed premiums', async () => {
    const result = await purchasePolicy({ ...DEFAULT_QUOTE, bundle: 'renters' });

    expect(result.status).toBe('bound');
    expect(result.policyNumber).toMatch(/^TRV-\d{6}$/);
    expect(result.package).toBe('Standard');
    expect(result.bundleLabel).toBe(BUNDLE_OFFERS.renters.label);
    expect(result.bundleSavings).toBe(21);

    const auto = result.policies.find((p) => p.line === 'auto');
    const renters = result.policies.find((p) => p.line === 'renters');
    expect(auto.premium).toBe(1688.2);
    expect(auto.premiumTax).toBe(33.76);
    expect(renters.premium).toBe(189);
    expect(renters.premiumTax).toBe(3.78);

    expect(result.annualPremium).toBe(1914.74);
    expect(result.monthlyPremium).toBe(162.56);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each([null, 'none'])('bundle %s binds auto-only with exact premiums', async (bundle) => {
    const result = await purchasePolicy({ ...DEFAULT_QUOTE, bundle });

    expect(result.status).toBe('bound');
    expect(result.bundleLabel).toBe('None');
    expect(result.bundleSavings).toBe(0);
    expect(result.policies).toHaveLength(1);
    expect(result.policies[0].line).toBe('auto');
    expect(result.policies[0].premium).toBe(1688.2);
    expect(result.policies[0].premiumTax).toBe(33.76);
    expect(result.annualPremium).toBe(1721.96);
    expect(result.monthlyPremium).toBe(146.5);
  });

  test('a driver under 25 applies the young-driver surcharge', async () => {
    const result = await purchasePolicy({
      ...DEFAULT_QUOTE,
      bundle: null,
      drivers: [{ name: 'Primary driver', age: 20 }],
    });

    expect(result.policies[0].premium).toBe(2270.32);
    expect(result.policies[0].premiumTax).toBe(45.41);
    expect(result.annualPremium).toBe(2315.73);
    expect(result.monthlyPremium).toBe(195.98);
  });

  test('annual payment plan drops the $3 installment fee', async () => {
    const result = await purchasePolicy({
      ...DEFAULT_QUOTE,
      bundle: null,
      paymentPlan: 'annual',
    });

    expect(result.paymentPlan).toBe('annual');
    expect(result.annualPremium).toBe(1721.96);
    expect(result.monthlyPremium).toBe(143.5);
  });

  test('resolveBundle maps keys and treats null/none as auto-only', () => {
    expect(resolveBundle(null)).toBeNull();
    expect(resolveBundle('none')).toBeNull();
    expect(resolveBundle(undefined)).toBeNull();
    expect(resolveBundle('home')).toBe(BUNDLE_OFFERS.home);
    expect(() => resolveBundle('umbrella')).toThrow(/Unknown bundle/);
  });

  test('applyBundleEndorsements appends the home endorsement only', () => {
    const lines = [{ policyLine: 'auto', premium: 100 }];

    const withHome = applyBundleEndorsements(lines, BUNDLE_OFFERS.home);
    expect(withHome).toHaveLength(2);
    expect(withHome[1].code).toBe('IDFX');
    expect(withHome[1].policyLine).toBe('identity-fraud');

    expect(applyBundleEndorsements(lines, BUNDLE_OFFERS.renters)).toHaveLength(1);
    expect(applyBundleEndorsements(lines, null)).toHaveLength(1);
  });

  test('buildPolicies groups lines by policyLine with auto default', () => {
    const policies = buildPolicies([
      { name: 'Auto', premium: 100 },
      { name: 'Home', premium: 200, policyLine: 'home' },
    ]);

    expect(policies.map((p) => p.line)).toEqual(['auto', 'home']);
    expect(policies[0].items).toHaveLength(1);
  });

  test('ratePolicy floors at the line minimum premium and adds the policy fee', () => {
    const rated = ratePolicy({
      line: 'auto',
      items: [{ premium: 100, premiumTaxRate: 0.02 }],
    });

    expect(rated.premium).toBe(625);
    expect(rated.premiumTax).toBe(12.5);
    expect(rated.label).toBe('Personal Auto');
  });

  test('coverage packages and state factors expose the expected shape', () => {
    expect(Object.keys(COVERAGE_PACKAGES)).toEqual(['basic', 'standard', 'premier']);
    expect(COVERAGE_PACKAGES.premier.features).toContain('Accident Forgiveness');
    expect(STATE_FACTORS.CT.factor).toBe(1.08);
    expect(Object.hasOwn(STATE_FACTORS, 'constructor')).toBe(false);
  });
});
