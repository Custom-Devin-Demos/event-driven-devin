const {
  submitInquiry,
  buildEngineCoverage,
  resolveOperatorProfile,
  resolveSupportRouting,
  ENGINE_PROGRAMS,
  SEGMENT_ROUTING,
} = require('../app/services/verticals/5b992ae7');

describe('Aerospace customer support inquiry service (5b992ae7)', () => {
  test('every program referenced by the routing table exists in the engine catalog', () => {
    Object.values(SEGMENT_ROUTING).forEach((routing) => {
      routing.programs.forEach((code) => {
        expect(ENGINE_PROGRAMS[code]).toBeDefined();
      });
    });
  });

  test('submits a US commercial-support inquiry and quotes narrowbody coverage', async () => {
    const summary = await submitInquiry({ topic: 'commercial-support', market: 'US' });

    expect(summary.success).toBe(true);
    expect(summary.desk).toBe('narrowbody-customer-support');
    expect(summary.region).toBe('north-america');
    expect(summary.programs.map((program) => program.code)).toEqual(['leap', 'cfm56', 'rise']);
    summary.programs.forEach((program) => {
      expect(typeof program.name).toBe('string');
      expect(typeof program.inService).toBe('number');
    });
  });

  test('builds coverage for the narrowbody segment including the RISE program', () => {
    const routing = resolveSupportRouting(resolveOperatorProfile('CA'));
    const coverage = buildEngineCoverage(routing);

    expect(coverage).toContainEqual({
      code: 'rise',
      name: ENGINE_PROGRAMS.rise.name,
      family: 'narrowbody',
      inService: ENGINE_PROGRAMS.rise.inService,
    });
  });

  test('skips unknown program codes instead of throwing', () => {
    expect(buildEngineCoverage({ programs: ['leap', 'unknown-program'] })).toEqual([
      {
        code: 'leap',
        name: ENGINE_PROGRAMS.leap.name,
        family: 'narrowbody',
        inService: ENGINE_PROGRAMS.leap.inService,
      },
    ]);
  });

  test('returns empty coverage when a routing entry has no programs', () => {
    expect(buildEngineCoverage({})).toEqual([]);
    expect(buildEngineCoverage({ programs: [] })).toEqual([]);
  });
});
