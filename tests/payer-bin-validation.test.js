jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(null),
}));

const {
  adjudicateClaim,
  generateMemberIdCard,
  PAYER_REGISTRY,
  PLAN_CONFIGS,
  MEMBERS,
} = require('../app/services/verticals/payer');

const {
  validateRxRouting,
  submitSyntheticClaim,
  welcomeSeasonPlans,
  BIN_LENGTH,
} = require('../scripts/welcome-season-sweep');

describe('payer pharmacy claim adjudication', () => {
  test('pays a claim for a member whose card carries a registered BIN', async () => {
    const result = await adjudicateClaim({ memberId: 'MEM-200145', ndc: '00093-7267-56' });

    expect(result.success).toBe(true);
    expect(result.status).toBe('paid');
    expect(result.routedTo).toBe(PAYER_REGISTRY[result.rxBin].name);
    expect(result.copay).toBe(10);
  });

  test('rejects with NCPDP reject 06 when the card BIN has no processor route', async () => {
    expect.assertions(3);
    try {
      await adjudicateClaim({ memberId: 'MEM-100234', ndc: '00093-7267-56' });
    } catch (error) {
      expect(error.rejectCode).toBe('06');
      expect(error.submittedBin).toBe('0044336');
      expect(error.rejectReason).toMatch(/not found in processor registry/);
    }
  });
});

describe('member ID card generation', () => {
  test('returns null for an unknown member', () => {
    expect(generateMemberIdCard('MEM-000000')).toBeNull();
  });

  test('carries the pharmacy routing fields from the plan configuration', () => {
    const card = generateMemberIdCard('MEM-200145');
    const plan = PLAN_CONFIGS[MEMBERS['MEM-200145'].planId];

    expect(card.rxBin).toBe(plan.rxBin);
    expect(card.rxPcn).toBe(plan.rxPcn);
    expect(card.rxGroup).toBe(plan.rxGroup);
  });
});

describe('welcome-season RxBIN validation', () => {
  const validConfig = { rxBin: '004336', rxPcn: 'ADV', rxGroup: 'RX0001' };

  test('accepts a registered six-digit BIN with a supported PCN', () => {
    expect(validateRxRouting(validConfig)).toEqual([]);
  });

  test('rejects a BIN that is not six digits', () => {
    const errors = validateRxRouting({ ...validConfig, rxBin: '0044336' });
    expect(errors.some((e) => e.includes(`${BIN_LENGTH} digits`))).toBe(true);
  });

  test('rejects a six-digit BIN that is not a registered processor', () => {
    const errors = validateRxRouting({ ...validConfig, rxBin: '999999' });
    expect(errors).toContain('RxBIN "999999" is not a registered processor BIN');
  });

  test('rejects a non-numeric BIN', () => {
    const errors = validateRxRouting({ ...validConfig, rxBin: '00A336' });
    expect(errors.some((e) => e.includes('is not numeric'))).toBe(true);
  });

  test('rejects a PCN the processor does not accept on that BIN', () => {
    const errors = validateRxRouting({ ...validConfig, rxPcn: 'MEDDADV' });
    expect(errors.some((e) => e.includes('is not accepted by'))).toBe(true);
  });

  test('a plan with an unroutable BIN fails the synthetic claim', () => {
    const claim = submitSyntheticClaim({ rxBin: '0044336' });
    expect(claim.paid).toBe(false);
    expect(claim.reason).toMatch(/reject 06/);
  });
});

describe('welcome-season sweep blast radius', () => {
  test('flags every Jan-1 plan whose cards would reject at the counter', () => {
    const failing = welcomeSeasonPlans(2026).filter(([, config]) => validateRxRouting(config).length > 0);
    const membersAtRisk = failing.reduce((sum, [, config]) => sum + config.memberCount, 0);

    expect(failing.map(([planId]) => planId).sort()).toEqual(['NCSHP-7030', 'NCSHP-8020']);
    expect(membersAtRisk).toBe(300000);
  });

  test('every plan configuration declares the routing fields a card needs', () => {
    for (const config of Object.values(PLAN_CONFIGS)) {
      expect(typeof config.rxBin).toBe('string');
      expect(typeof config.rxPcn).toBe('string');
      expect(typeof config.rxGroup).toBe('string');
      expect(typeof config.memberCount).toBe('number');
    }
  });
});
