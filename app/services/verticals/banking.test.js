// Mock uuid before requiring banking module (uuid is ESM-only)
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { processTransfer } = require('./banking');

// Mock dependencies to isolate the banking service logic
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  error: jest.fn(),
}));
jest.mock('../../telemetry/datadog', () => ({
  incrementMetric: jest.fn(),
  recordTiming: jest.fn(),
}));
jest.mock('../../telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
}));
jest.mock('../devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue({}),
}));

describe('processTransfer', () => {
  const validTransfer = {
    fromAccount: 'ACCT-1001',
    toAccount: 'ACCT-1002',
    amount: 500,
    accountTier: 'premium',
    userId: 'usr_test',
  };

  it('should complete a transfer successfully for a premium tier account', async () => {
    const result = await processTransfer(validTransfer);

    expect(result.success).toBe(true);
    expect(result.transferId).toBeDefined();
    expect(result.status).toBe('completed');
    expect(result.receipt).toBeDefined();
    expect(result.receipt.fee).toBe('0.00');
    expect(result.receipt.totalDebit).toBe('500.00');
    expect(result.fee).toBe('0.00');
    expect(result.debitAmount).toBe('500.00');
  });

  it('should handle case-insensitive account tier (e.g. "Premium" vs "premium")', async () => {
    const result = await processTransfer({
      ...validTransfer,
      accountTier: 'Premium',
    });

    expect(result.success).toBe(true);
    expect(result.receipt.fee).toBe('0.00');
    expect(result.receipt.totalDebit).toBe('500.00');
  });

  it('should calculate correct fees for standard tier', async () => {
    const result = await processTransfer({
      ...validTransfer,
      accountTier: 'standard',
    });

    expect(result.success).toBe(true);
    // standard tier: rate=0.001, flat=2.50; fee = max(0.001*500, 2.50) = max(0.50, 2.50) = 2.50
    expect(result.receipt.fee).toBe('2.50');
    expect(result.receipt.totalDebit).toBe('502.50');
  });

  it('should calculate correct fees for basic tier', async () => {
    const result = await processTransfer({
      ...validTransfer,
      accountTier: 'basic',
    });

    expect(result.success).toBe(true);
    // basic tier: rate=0.002, flat=4.99; fee = max(0.002*500, 4.99) = max(1.00, 4.99) = 4.99
    expect(result.receipt.fee).toBe('4.99');
    expect(result.receipt.totalDebit).toBe('504.99');
  });

  it('should handle mixed-case account tier values', async () => {
    const result = await processTransfer({
      ...validTransfer,
      accountTier: 'BASIC',
    });

    expect(result.success).toBe(true);
    expect(result.receipt.fee).toBe('4.99');
  });

  it('should throw an error for an unknown account tier', async () => {
    await expect(
      processTransfer({
        ...validTransfer,
        accountTier: 'platinum',
      })
    ).rejects.toThrow();
  });
});
