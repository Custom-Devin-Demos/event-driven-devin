const {
  submitInquiry,
  ENGINE_PROGRAMS,
  SEGMENT_ROUTING,
  buildEngineCoverage,
  resolveOperatorProfile,
  resolveSupportRouting,
} = require('../app/services/verticals/5b992ae7');

describe('Aerospace customer support inquiry service (5b992ae7)', () => {
  test('every program referenced by the routing table has an engine program entry', () => {
    Object.values(SEGMENT_ROUTING).forEach((routing) => {
      routing.programs.forEach((code) => {
        expect(ENGINE_PROGRAMS[code]).toBeDefined();
      });
    });
  });

  test('narrowbody routing resolves full engine coverage including RISE', () => {
    const routing = SEGMENT_ROUTING.commercial_narrowbody;
    const coverage = buildEngineCoverage(routing);

    expect(coverage.map((program) => program.code)).toEqual(['leap', 'cfm56', 'rise']);
    coverage.forEach((program) => {
      expect(typeof program.name).toBe('string');
      expect(typeof program.family).toBe('string');
      expect(typeof program.inService).toBe('number');
    });
  });

  test('unknown program codes are skipped instead of throwing', () => {
    const coverage = buildEngineCoverage({
      desk: 'narrowbody-customer-support',
      responseSlaHours: 24,
      programs: ['leap', 'not-a-program'],
    });

    expect(coverage.map((program) => program.code)).toEqual(['leap']);
  });

  test('a US inquiry is accepted and routed to the narrowbody desk', async () => {
    const summary = await submitInquiry({ topic: 'commercial-support', market: 'US' });

    expect(summary.success).toBe(true);
    expect(summary.status).toBe('received');
    expect(summary.desk).toBe('narrowbody-customer-support');
    expect(summary.region).toBe('north-america');
    expect(summary.programs.map((program) => program.code)).toEqual(['leap', 'cfm56', 'rise']);
  });

  test.each([
    ['GB', 'widebody-customer-support'],
    ['SG', 'business-regional-support'],
    ['ZZ', 'narrowbody-customer-support'],
  ])('an inquiry from %s is accepted and routed to %s', async (market, desk) => {
    const summary = await submitInquiry({ topic: 'commercial-support', market });

    expect(summary.success).toBe(true);
    expect(summary.desk).toBe(desk);
    expect(summary.programs.length).toBeGreaterThan(0);
  });

  test('a missing market falls back to the US operator profile', () => {
    const profile = resolveOperatorProfile(undefined);
    const routing = resolveSupportRouting(profile);

    expect(profile.segment).toBe('commercial_narrowbody');
    expect(routing.desk).toBe('narrowbody-customer-support');
  });
});
