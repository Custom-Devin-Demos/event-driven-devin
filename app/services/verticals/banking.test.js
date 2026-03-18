// Mock uuid before importing banking module (uuid uses ESM exports)
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

const { processTransfer } = require('./banking');

// Mock telemetry modules to avoid side effects during tests
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
  it('should complete a transfer with premium tier (zero fee)', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 500,
      accountTier: 'premium',
      userId: 'usr_test_1',
    });

    expect(result.success).toBe(true);
    expect(result.transferId).toBeDefined();
    expect(result.fee).toBe('0.00');
    expect(result.debitAmount).toBe('500.00');
    expect(result.receipt).toBeDefined();
    expect(result.receipt.fee).toBe('0.00');
    expect(result.receipt.totalDebit).toBe('500.00');
  });

  it('should handle case-insensitive account tier (Premium vs premium)', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 500,
      accountTier: 'Premium',
      userId: 'usr_test_2',
    });

    expect(result.success).toBe(true);
    expect(result.fee).toBe('0.00');
    expect(result.debitAmount).toBe('500.00');
  });

  it('should calculate correct fee for standard tier', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 500,
      accountTier: 'standard',
      userId: 'usr_test_3',
    });

    expect(result.success).toBe(true);
    // standard: rate=0.001, flat=2.50; 500*0.001=0.50, max(0.50,2.50)=2.50
    expect(result.fee).toBe('2.50');
    expect(result.debitAmount).toBe('502.50');
  });

  it('should calculate correct fee for basic tier', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 500,
      accountTier: 'basic',
      userId: 'usr_test_4',
    });

    expect(result.success).toBe(true);
    // basic: rate=0.002, flat=4.99; 500*0.002=1.00, max(1.00,4.99)=4.99
    expect(result.fee).toBe('4.99');
    expect(result.debitAmount).toBe('504.99');
  });

  it('should handle mixed-case tier names', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 1000,
      accountTier: 'STANDARD',
      userId: 'usr_test_5',
    });

    expect(result.success).toBe(true);
    // standard: rate=0.001, flat=2.50; 1000*0.001=1.00, max(1.00,2.50)=2.50
    expect(result.fee).toBe('2.50');
    expect(result.debitAmount).toBe('1002.50');
  });

  it('should use rate-based fee when it exceeds the flat minimum', async () => {
    const result = await processTransfer({
      fromAccount: 'ACCT-1001',
      toAccount: 'ACCT-1002',
      amount: 10000,
      accountTier: 'standard',
      userId: 'usr_test_6',
    });

    expect(result.success).toBe(true);
    // standard: rate=0.001, flat=2.50; 10000*0.001=10.00, max(10.00,2.50)=10.00
    expect(result.fee).toBe('10.00');
    expect(result.debitAmount).toBe('10010.00');
  });
});
