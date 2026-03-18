// Mock uuid before requiring banking.js since uuid uses ESM
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { processTransfer } = require('./banking');

// Mock external dependencies to isolate unit tests
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
  it('should complete a transfer for the premium tier without errors', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 500,
      accountTier: 'premium',
      userId: 'usr_test_1',
    });

    expect(result.success).toBe(true);
    expect(result.status).toBe('completed');
    expect(result.receipt).toBeDefined();
    expect(result.receipt.fee).toBe('0.00');
    expect(result.receipt.totalDebit).toBe('500.00');
  });

  it('should handle case-insensitive account tier (e.g. "Premium" with capital P)', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 500,
      accountTier: 'Premium',
      userId: 'usr_test_2',
    });

    expect(result.success).toBe(true);
    expect(result.receipt).toBeDefined();
    expect(result.receipt.fee).toBe('0.00');
    expect(result.receipt.totalDebit).toBe('500.00');
  });

  it('should calculate the correct fee for the standard tier', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 500,
      accountTier: 'standard',
      userId: 'usr_test_3',
    });

    expect(result.success).toBe(true);
    expect(result.receipt).toBeDefined();
    // standard tier: rate=0.001, flat=2.50
    // baseFee = 0.001 * 500 = 0.50, minimumFee = 2.50, fee = max(0.50, 2.50) = 2.50
    expect(result.receipt.fee).toBe('2.50');
    expect(result.receipt.totalDebit).toBe('502.50');
  });

  it('should calculate the correct fee for the basic tier', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 5000,
      accountTier: 'basic',
      userId: 'usr_test_4',
    });

    expect(result.success).toBe(true);
    expect(result.receipt).toBeDefined();
    // basic tier: rate=0.002, flat=4.99
    // baseFee = 0.002 * 5000 = 10.00, minimumFee = 4.99, fee = max(10.00, 4.99) = 10.00
    expect(result.receipt.fee).toBe('10.00');
    expect(result.receipt.totalDebit).toBe('5010.00');
  });

  it('should throw an error for an unknown account tier', async () => {
    await expect(
      processTransfer({
        fromAccount: 'ACCT-1001',
        toAccount: 'ACCT-1002',
        amount: 500,
        accountTier: 'nonexistent',
        userId: 'usr_test_5',
      })
    ).rejects.toThrow();
  });
});
