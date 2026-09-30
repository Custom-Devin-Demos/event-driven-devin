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
  processEnrollment,
  computeMonthlyPremium,
  formatEnrollmentSummary,
  applyRequiredBenefits,
  PLAN_CATALOG,
} = require('../app/services/verticals/9fdcf315');

const DEFAULT_ENROLLMENT = {
  userId: 'test-user',
  items: [
    { planId: 'ANT-MED-GOLD-PPO', premium: 612.40 },
    { planId: 'ANT-DEN-ESSENTIAL', premium: 38.20 },
    { planId: 'ANT-VIS-BLUEVIEW', premium: 12.60 },
  ],
  state: 'IN',
  household: [
    { relationship: 'self', age: 41 },
    { relationship: 'spouse', age: 39 },
    { relationship: 'child', age: 8 },
  ],
  coverageStart: '2027-01-01',
};

const ADULT_ONLY_HOUSEHOLD = [
  { relationship: 'self', age: 41 },
  { relationship: 'spouse', age: 39 },
];

describe('Anthem enrollment', () => {
  test.each(['ZZ', 'constructor'])('processEnrollment rejects invalid state %s without triggering telemetry or a Devin session', async (state) => {
    jest.clearAllMocks();

    await expect(processEnrollment({ ...DEFAULT_ENROLLMENT, state }))
      .rejects.toMatchObject({
        name: 'ValidationError',
        code: 'INVALID_STATE',
        status: 400,
      });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('processEnrollment rejects items with no medical plan without triggering telemetry or a Devin session', async () => {
    jest.clearAllMocks();

    await expect(processEnrollment({
      ...DEFAULT_ENROLLMENT,
      items: [{ planId: 'ANT-DEN-ESSENTIAL', premium: 38.20 }],
    })).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'NO_MEDICAL_PLAN',
      status: 400,
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each([0, -10])('processEnrollment rejects a mismatched premium %s without triggering telemetry or a Devin session', async (premium) => {
    jest.clearAllMocks();

    await expect(processEnrollment({
      ...DEFAULT_ENROLLMENT,
      items: [{ planId: 'ANT-MED-GOLD-PPO', premium }],
    })).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'PREMIUM_MISMATCH',
      status: 400,
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('processEnrollment rejects an uncatalogued planId without triggering telemetry or a Devin session', async () => {
    jest.clearAllMocks();

    await expect(processEnrollment({
      ...DEFAULT_ENROLLMENT,
      items: [
        { planId: 'ANT-MED-GOLD-PPO', premium: 612.40 },
        { planId: 'ANT-EHB-PEDDENTAL', premium: 0 },
      ],
    })).rejects.toMatchObject({
      name: 'ValidationError',
      code: 'UNKNOWN_PLAN',
      status: 400,
    });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each([
    [[]],
    [[{ relationship: 'child', age: 8 }]],
  ])('processEnrollment rejects a household without a primary applicant %j without triggering telemetry or a Devin session', async (household) => {
    jest.clearAllMocks();

    await expect(processEnrollment({ ...DEFAULT_ENROLLMENT, household }))
      .rejects.toMatchObject({
        name: 'ValidationError',
        code: 'NO_PRIMARY_APPLICANT',
        status: 400,
      });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test.each(['', 'not-a-date'])('processEnrollment rejects invalid coverageStart "%s" without triggering telemetry or a Devin session', async (coverageStart) => {
    jest.clearAllMocks();

    await expect(processEnrollment({ ...DEFAULT_ENROLLMENT, coverageStart }))
      .rejects.toMatchObject({
        name: 'ValidationError',
        code: 'INVALID_COVERAGE_START',
        status: 400,
      });

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(Sentry.captureException).not.toHaveBeenCalled();
  });

  test('processEnrollment rejects with the planted TypeError and triggers a Devin session', async () => {
    await expect(processEnrollment(DEFAULT_ENROLLMENT))
      .rejects.toThrow(/reading 'planName'/);
    await expect(processEnrollment(DEFAULT_ENROLLMENT))
      .rejects.toBeInstanceOf(TypeError);

    expect(createSessionAndAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        customer: '9fdcf315',
        service: 'anthem-enrollment',
      }),
    );

    expect(Sentry.captureException).toHaveBeenCalled();
    expect(Sentry.captureException.mock.calls[0][1].tags.alert_path).toBe('instant');
  });

  test('processEnrollment succeeds for an adult-only household', async () => {
    jest.clearAllMocks();

    const result = await processEnrollment({
      ...DEFAULT_ENROLLMENT,
      household: ADULT_ONLY_HOUSEHOLD,
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('confirmed');
    expect(result.monthlyPremium).toBe(663.20);
    expect(result.carrierName).toBe('Anthem Blue Cross and Blue Shield');
    expect(result.exchange).toBe('HealthCare.gov');
    expect(result.coverageStart).toBe('2027-01-01');
    expect(result.summary).toHaveLength(3);
    expect(result.summary[0].planName).toBe('Anthem Gold PPO 1000');
    expect(result.summary[0].metalTier).toBe('Gold');
    expect(result.summary[0].embedded).toBe(false);

    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('processEnrollment succeeds with a child when a family dental plan covers pediatric dental', async () => {
    jest.clearAllMocks();

    const result = await processEnrollment({
      ...DEFAULT_ENROLLMENT,
      items: [
        { planId: 'ANT-MED-GOLD-PPO', premium: 612.40 },
        { planId: 'ANT-DEN-FAMILY', premium: 64.75 },
        { planId: 'ANT-VIS-BLUEVIEW', premium: 12.60 },
      ],
    });

    expect(result.success).toBe(true);
    expect(result.monthlyPremium).toBe(689.75);
    expect(result.summary).toHaveLength(3);
    expect(result.summary[1].planName).toBe('Anthem Dental Family Prime');

    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test.each(['ZZ', 'constructor'])('computeMonthlyPremium rejects invalid state %s', (state) => {
    expect(() => computeMonthlyPremium(DEFAULT_ENROLLMENT.items, state)).toThrow(`Unknown state: ${state}`);
    try {
      computeMonthlyPremium(DEFAULT_ENROLLMENT.items, state);
    } catch (error) {
      expect(error.code).toBe('INVALID_STATE');
    }
  });

  test('computeMonthlyPremium sums premiums and returns carrier and exchange', () => {
    const result = computeMonthlyPremium(DEFAULT_ENROLLMENT.items, 'NY');

    expect(result.monthlyPremium).toBe(663.20);
    expect(result.carrierName).toBe('Anthem Blue Cross Blue Shield');
    expect(result.exchange).toBe('NY State of Health');
  });

  test('applyRequiredBenefits embeds the pediatric dental rider when a child lacks coverage', () => {
    const items = applyRequiredBenefits(DEFAULT_ENROLLMENT.items, DEFAULT_ENROLLMENT.household);

    expect(items).toHaveLength(4);
    expect(items[3]).toEqual({ planId: 'ANT-EHB-PEDDENTAL', premium: 0, embedded: true });
  });

  test('applyRequiredBenefits leaves items unchanged for an adult-only household', () => {
    const items = applyRequiredBenefits(DEFAULT_ENROLLMENT.items, ADULT_ONLY_HOUSEHOLD);

    expect(items).toBe(DEFAULT_ENROLLMENT.items);
  });

  test('applyRequiredBenefits leaves items unchanged when a plan covers pediatric dental', () => {
    const selected = [
      { planId: 'ANT-MED-GOLD-PPO', premium: 612.40 },
      { planId: 'ANT-DEN-FAMILY', premium: 64.75 },
    ];
    const items = applyRequiredBenefits(selected, DEFAULT_ENROLLMENT.household);

    expect(items).toBe(selected);
  });

  test('formatEnrollmentSummary returns plan details for catalog-only items', () => {
    const summary = formatEnrollmentSummary(DEFAULT_ENROLLMENT.items);

    expect(summary).toHaveLength(3);
    expect(summary[0].planName).toBe('Anthem Gold PPO 1000');
    expect(summary[0].network).toBe('Pathway PPO');
    expect(summary[1].category).toBe('dental');
    expect(summary[2].metalTier).toBeNull();
  });

  test('formatEnrollmentSummary throws once the pediatric rider is merged in', () => {
    const allItems = applyRequiredBenefits(DEFAULT_ENROLLMENT.items, DEFAULT_ENROLLMENT.household);

    expect(() => formatEnrollmentSummary(allItems)).toThrow(TypeError);
  });

  test('every catalog id carries the ANT- prefix', () => {
    expect(PLAN_CATALOG.every((p) => p.id.startsWith('ANT-'))).toBe(true);
  });
});
