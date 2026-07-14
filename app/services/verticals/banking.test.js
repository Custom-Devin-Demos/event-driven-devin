jest.mock('uuid', () => ({ v4: () => 'test-uuid-0000' }));
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
  warn: jest.fn(),
}));
jest.mock('../../telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../../telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const { createSessionAndAlert } = require('../devin-session');
const { processTransfer } = require('./banking');

describe('banking processTransfer — fee tier regression', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // Reproduces the original failure: the transfer used to throw
  // "TypeError: Cannot read properties of undefined (reading 'rate')"
  // because resolveFeeTier was not awaited and returned the wrong shape.
  it('completes a premium-tier transfer without throwing (original failure condition)', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 500,
      accountTier: 'premium',
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.receipt.fee).toBe('0.00');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  // The route default passes 'Premium' (capitalized) while FEE_TIERS keys
  // are lowercase; the lookup must be case-insensitive.
  it('resolves a capitalized tier label (route default) and computes the fee', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 10000,
      accountTier: 'Standard',
    });

    expect(result.success).toBe(true);
    // standard: rate 0.001 * 10000 = 10, min flat 2.50 -> 10.00
    expect(result.receipt.fee).toBe('10.00');
  });

  // Edge case: an unknown tier must fail cleanly with a domain error,
  // not a TypeError from dereferencing undefined.
  it('throws a clean InvalidAccountTierError for an unknown tier', async () => {
    await expect(
      processTransfer({
        fromAccount: 'ACCT-1001',
        toAccount: 'ACCT-1002',
        amount: 500,
        accountTier: 'nonexistent-tier',
      })
    ).rejects.toMatchObject({
      name: 'InvalidAccountTierError',
      code: 'INVALID_ACCOUNT_TIER',
    });
  });
});
