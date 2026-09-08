const {
  processTransfer,
  COMPLIANCE_CONFIG,
  SCREENING_MAX_CONCURRENCY,
  screeningCallsInFlightCount,
} = require('../app/services/oncall-verticals/banking');

describe('on-call banking transfer compliance screening', () => {
  test('ships a concurrency default within the partner ceiling', () => {
    expect(COMPLIANCE_CONFIG.screeningConcurrency).toBeGreaterThan(1);
    expect(COMPLIANCE_CONFIG.screeningConcurrency).toBeLessThanOrEqual(SCREENING_MAX_CONCURRENCY);
    expect(COMPLIANCE_CONFIG.screeningWindowDays).toBe(90);
  });

  test('screens the full window in parallel batches', async () => {
    const started = Date.now();
    const result = await processTransfer({
      fromAccount: 'ACCT-1002',
      toAccount: 'ACCT-1001',
      amount: 500,
      accountTier: 'standard',
    });
    expect(result.success).toBe(true);
    expect(Date.now() - started).toBeLessThan(3000);
  });

  test('holds concurrent transfers to the partner-wide call budget', async () => {
    let peak = 0;
    const sampler = setInterval(() => {
      peak = Math.max(peak, screeningCallsInFlightCount());
    }, 5);

    const transfers = Array.from({ length: 4 }, () => processTransfer({
      fromAccount: 'ACCT-1002',
      toAccount: 'ACCT-1001',
      amount: 500,
      accountTier: 'standard',
    }));
    const results = await Promise.all(transfers);
    clearInterval(sampler);

    expect(results.every((r) => r.success)).toBe(true);
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(SCREENING_MAX_CONCURRENCY);
    expect(screeningCallsInFlightCount()).toBe(0);
  });
});
