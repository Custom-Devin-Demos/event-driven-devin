function loadBanking() {
  const saved = { days: process.env.SCREENING_WINDOW_DAYS, conc: process.env.SCREENING_CONCURRENCY };
  delete process.env.SCREENING_WINDOW_DAYS;
  delete process.env.SCREENING_CONCURRENCY;
  let mod;
  jest.isolateModules(() => {
    mod = require('../app/services/oncall-verticals/banking');
  });
  if (saved.days !== undefined) process.env.SCREENING_WINDOW_DAYS = saved.days;
  if (saved.conc !== undefined) process.env.SCREENING_CONCURRENCY = saved.conc;
  return mod;
}

const {
  runComplianceScreening,
  COMPLIANCE_CONFIG,
  SCREENING_PARTNER_MAX_IN_FLIGHT,
} = loadBanking();

describe('on-call banking compliance screening', () => {
  test('ships a parallel screening default within the partner ceiling', () => {
    expect(COMPLIANCE_CONFIG.screeningWindowDays).toBe(90);
    expect(COMPLIANCE_CONFIG.screeningConcurrency).toBeGreaterThan(1);
    expect(COMPLIANCE_CONFIG.screeningConcurrency).toBeLessThanOrEqual(SCREENING_PARTNER_MAX_IN_FLIGHT);
  });

  test('screens the full 90-day window for a standard account well under 1.5s', async () => {
    const start = Date.now();
    const result = await runComplianceScreening('ACCT-1002', 'standard');
    const elapsed = Date.now() - start;
    expect(result.screened).toBe(36);
    expect(result.cleared).toBe(true);
    expect(elapsed).toBeLessThan(1500);
  });

  test('overlapping transfers all screen every transaction', async () => {
    const results = await Promise.all(
      Array.from({ length: 4 }, () => runComplianceScreening('ACCT-1003', 'basic')),
    );
    results.forEach((r) => {
      expect(r.screened).toBe(36);
      expect(r.cleared).toBe(true);
    });
  });
});
