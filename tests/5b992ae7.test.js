const {
  submitInquiry,
  ENGINE_PROGRAMS,
  SEGMENT_ROUTING,
  resolveOperatorProfile,
  resolveSupportRouting,
  buildEngineCoverage,
} = require('../app/services/verticals/5b992ae7');

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(() => Promise.resolve()),
}));

describe('Aerospace customer support inquiry service (5b992ae7)', () => {
  test('every program referenced by SEGMENT_ROUTING exists in ENGINE_PROGRAMS', () => {
    Object.values(SEGMENT_ROUTING).forEach((routing) => {
      routing.programs.forEach((code) => {
        expect(ENGINE_PROGRAMS[code]).toBeDefined();
      });
    });
  });

  test('US market inquiry (commercial_narrowbody) succeeds and quotes all narrowbody programs', async () => {
    const summary = await submitInquiry({ topic: 'commercial-support', market: 'US' });

    expect(summary.success).toBe(true);
    expect(summary.desk).toBe('narrowbody-customer-support');
    expect(summary.programs.map((p) => p.code)).toEqual(['leap', 'cfm56', 'rise']);
    expect(summary.programs.find((p) => p.code === 'rise').name).toBe('CFM RISE');
  });

  test('buildEngineCoverage resolves every program for each routing segment', () => {
    Object.values(SEGMENT_ROUTING).forEach((routing) => {
      const coverage = buildEngineCoverage(routing);
      expect(coverage).toHaveLength(routing.programs.length);
      coverage.forEach((entry) => {
        expect(entry).toEqual(ENGINE_PROGRAMS[entry.code]);
      });
    });
  });

  test('buildEngineCoverage skips unknown program codes instead of throwing', () => {
    const coverage = buildEngineCoverage({
      desk: 'test-desk',
      programs: ['leap', 'not-a-program', 'genx'],
    });

    expect(coverage.map((p) => p.code)).toEqual(['leap', 'genx']);
  });

  test('buildEngineCoverage tolerates missing programs list', () => {
    expect(buildEngineCoverage({ desk: 'test-desk' })).toEqual([]);
    expect(buildEngineCoverage(undefined)).toEqual([]);
  });

  test('unknown markets fall back to the US profile and still succeed', async () => {
    const profile = resolveOperatorProfile('zz');
    expect(profile.segment).toBe('commercial_narrowbody');
    expect(resolveSupportRouting(profile).desk).toBe('narrowbody-customer-support');

    const summary = await submitInquiry({ topic: 'commercial-support', market: 'zz' });
    expect(summary.success).toBe(true);
    expect(summary.programs).toHaveLength(3);
  });
});
