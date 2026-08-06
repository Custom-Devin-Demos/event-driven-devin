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
  sweep,
  BIN_LENGTH,
} = require('../scripts/welcome-season-sweep');

describe('payer pharmacy claim adjudication', () => {
  test('pays a claim for a member whose card carries a registered BIN', async () => {
    const result = await adjudicateClaim({ memberId: 'MEM-200145', ndc: '00078-0592-15' });

    expect(result.success).toBe(true);
    expect(result.status).toBe('paid');
    expect(result.routedTo).toBe(PAYER_REGISTRY[result.rxBin].name);
    expect(result.copay).toBe(50);
    expect(result.indication).toBe('Chronic myeloid leukemia');
  });

  test('rejects with NCPDP reject 06 when the card BIN has no processor route', async () => {
    expect.assertions(3);
    try {
      await adjudicateClaim({ memberId: 'MEM-100234', ndc: '00078-0592-15' });
    } catch (error) {
      expect(error.rejectCode).toBe('06');
      expect(error.submittedBin).toBe('0044336');
      expect(error.rejectReason).toMatch(/not found in processor registry/);
    }
  });

  test('fails a claim for an unenrolled member without raising a routing error', async () => {
    expect.assertions(2);
    try {
      await adjudicateClaim({ memberId: 'MEM-000000', ndc: '00078-0592-15' });
    } catch (error) {
      expect(error.code).toBe('MEMBER_NOT_FOUND');
      expect(error.rejectCode).toBeUndefined();
    }
  });

  test('refuses a medication that is not on the formulary instead of substituting one', async () => {
    expect.assertions(2);
    try {
      await adjudicateClaim({ memberId: 'MEM-200145', ndc: '00000-0000-00' });
    } catch (error) {
      expect(error.code).toBe('DRUG_NOT_ON_FORMULARY');
      expect(error.rejectCode).toBeUndefined();
    }
  });
});

describe('member ID card generation', () => {
  test('returns null for an unknown member', () => {
    expect(generateMemberIdCard('MEM-000000')).toBeNull();
  });

  test('treats an inherited Object.prototype key as an unknown member', () => {
    for (const key of ['__proto__', 'constructor', 'toString']) {
      expect(generateMemberIdCard(key)).toBeNull();
    }
  });

  test('carries the pharmacy routing fields from the plan configuration', () => {
    const card = generateMemberIdCard('MEM-200145');
    const plan = PLAN_CONFIGS[MEMBERS['MEM-200145'].planId];

    expect(card.rxBin).toBe(plan.rxBin);
    expect(card.rxPcn).toBe(plan.rxPcn);
    expect(card.rxGroup).toBe(plan.rxGroup);
  });

  test('distinguishes a missing plan configuration from an unenrolled member', () => {
    const planId = MEMBERS['MEM-200145'].planId;
    const plan = PLAN_CONFIGS[planId];
    delete PLAN_CONFIGS[planId];

    try {
      expect(() => generateMemberIdCard('MEM-200145')).toThrow(/Plan configuration/);
      try {
        generateMemberIdCard('MEM-200145');
      } catch (error) {
        expect(error.code).toBe('PLAN_CONFIG_MISSING');
      }
    } finally {
      PLAN_CONFIGS[planId] = plan;
    }
  });
});

describe('welcome-season RxBIN validation', () => {
  const validConfig = {
    rxBin: '004336', rxPcn: 'ADV', rxGroup: 'RX0001', memberCount: 1000,
  };

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

  test('rejects a plan configuration that declares no member count', () => {
    const { memberCount: _memberCount, ...withoutCount } = validConfig;
    const errors = validateRxRouting(withoutCount);
    expect(errors.some((e) => e.includes('memberCount is missing'))).toBe(true);
  });

  test('sweeps a plan whose planYear disagrees with its Jan-1 effective date, and reports it', () => {
    const typo = {
      ...validConfig, planYear: 2025, effectiveDate: '2026-01-01',
    };
    expect(validateRxRouting(typo, 2026).some((e) => e.includes('planYear 2025 is not the 2026'))).toBe(true);
  });

  test('a plan with an unroutable BIN fails the synthetic claim', () => {
    const claim = submitSyntheticClaim({ rxBin: '0044336' });
    expect(claim.paid).toBe(false);
    expect(claim.reason).toMatch(/reject 06/);
  });

  test('a plan whose processor does not accept its PCN fails the synthetic claim', () => {
    const claim = submitSyntheticClaim({ rxBin: '610502', rxPcn: 'ADV' });
    expect(claim.paid).toBe(false);
    expect(claim.reason).toMatch(/does not accept PCN/);
  });
});

describe('welcome-season sweep blast radius', () => {
  test('flags every Jan-1 plan whose cards would reject at the counter', () => {
    const failing = welcomeSeasonPlans(2026).filter(([, config]) => validateRxRouting(config).length > 0);
    const membersAtRisk = failing.reduce((sum, [, config]) => sum + config.memberCount, 0);

    expect(failing.map(([planId]) => planId).sort()).toEqual(['NCSHP-7030', 'NCSHP-8020']);
    expect(membersAtRisk).toBe(300000);
  });

  test('fails rather than passing silently when no plans were validated', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      expect(welcomeSeasonPlans(1999)).toEqual([]);
      expect(sweep(1999)).toBe(1);
    } finally {
      write.mockRestore();
    }
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
