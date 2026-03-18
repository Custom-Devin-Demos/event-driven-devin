// Mock uuid before requiring banking.js since uuid is ESM-only
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { processTransfer } = require('./banking');

// Mock dependencies to isolate unit tests
jest.mock('../../telemetry/logger', () => ({
  info: jest.fn(),
  warn: jest.fn(),
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
  const baseTransferData = {
    fromAccount: 'ACCT-1001',
    toAccount: 'ACCT-1002',
    amount: 500,
    accountTier: 'premium',
    userId: 'usr_test_1',
  };

  it('should succeed with lowercase premium tier', async () => {
    const result = await processTransfer(baseTransferData);
    expect(result.success).toBe(true);
    expect(result.receipt).toBeDefined();
    expect(result.receipt.fee).toBe('0.00');
    expect(result.receipt.totalDebit).toBe('500.00');
  });

  it('should succeed with uppercase Premium tier (original bug trigger)', async () => {
    const result = await processTransfer({
      ...baseTransferData,
      accountTier: 'Premium',
    });
    expect(result.success).toBe(true);
    expect(result.receipt).toBeDefined();
    expect(result.receipt.fee).toBe('0.00');
    expect(result.receipt.totalDebit).toBe('500.00');
  });

  it('should succeed with mixed-case tier names', async () => {
    const result = await processTransfer({
      ...baseTransferData,
      accountTier: 'STANDARD',
    });
    expect(result.success).toBe(true);
    expect(result.receipt).toBeDefined();
    expect(parseFloat(result.receipt.fee)).toBeGreaterThanOrEqual(0);
  });

  it('should correctly calculate fee for standard tier', async () => {
    const result = await processTransfer({
      ...baseTransferData,
      accountTier: 'standard',
      amount: 10000,
    });
    expect(result.success).toBe(true);
    // standard: rate=0.001, flat=2.50
    // rate-based: 10000 * 0.001 = 10.00
    // Math.max(10.00, 2.50) = 10.00
    expect(result.receipt.fee).toBe('10.00');
    expect(result.receipt.totalDebit).toBe('10010.00');
  });

  it('should correctly calculate fee for basic tier', async () => {
    const result = await processTransfer({
      ...baseTransferData,
      accountTier: 'basic',
      amount: 500,
    });
    expect(result.success).toBe(true);
    // basic: rate=0.002, flat=4.99
    // rate-based: 500 * 0.002 = 1.00
    // Math.max(1.00, 4.99) = 4.99
    expect(result.receipt.fee).toBe('4.99');
    expect(result.receipt.totalDebit).toBe('504.99');
  });

  it('should throw an error for an unknown account tier', async () => {
    await expect(
      processTransfer({
        ...baseTransferData,
        accountTier: 'nonexistent',
      })
    ).rejects.toThrow('Unknown account tier: nonexistent');
  });

  it('should throw an error when accountTier is undefined', async () => {
    await expect(
      processTransfer({
        ...baseTransferData,
        accountTier: undefined,
      })
    ).rejects.toThrow('Unknown account tier');
  });

  it('should throw an error when accountTier is null', async () => {
    await expect(
      processTransfer({
        ...baseTransferData,
        accountTier: null,
      })
    ).rejects.toThrow('Unknown account tier');
  });

  it('should include receipt with expected fields', async () => {
    const result = await processTransfer(baseTransferData);
    expect(result.receipt).toHaveProperty('receiptId');
    expect(result.receipt).toHaveProperty('from', 'ACCT-1001');
    expect(result.receipt).toHaveProperty('to', 'ACCT-1002');
    expect(result.receipt).toHaveProperty('amount', 500);
    expect(result.receipt).toHaveProperty('fee');
    expect(result.receipt).toHaveProperty('totalDebit');
    expect(result.receipt).toHaveProperty('timestamp');
  });
});
