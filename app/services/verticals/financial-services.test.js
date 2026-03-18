// Mock dependencies to isolate unit tests
jest.mock('uuid', () => ({
  v4: () => 'test-trade-id-1234',
}));
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

const { executeTrade, COMMISSION_TIERS } = require('./financial-services');

describe('executeTrade', () => {
  const validTradeData = {
    symbol: 'AAPL',
    side: 'buy',
    quantity: 10,
    price: 227.63,
    tierId: 1,
    accountId: 'ACCT-INV-001',
  };

  it('should execute a trade successfully with standard tier (tierId=1)', async () => {
    const result = await executeTrade(validTradeData);

    expect(result.success).toBe(true);
    expect(result.symbol).toBe('AAPL');
    expect(result.side).toBe('buy');
    expect(result.quantity).toBe(10);
    expect(result.price).toBe(227.63);
    expect(result.executionPrice).toBe(227.63);
    expect(result.status).toBe('filled');
    expect(typeof result.fee).toBe('number');
    expect(typeof result.commission).toBe('number');
    expect(result.fee).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
    expect(result.filledAt).toBeDefined();
    expect(result.tradeId).toBeDefined();
  });

  it('should execute a trade successfully with active trader tier (tierId=2)', async () => {
    const result = await executeTrade({ ...validTradeData, tierId: 2 });

    expect(result.success).toBe(true);
    expect(result.fee).toBeGreaterThan(0);
    expect(result.commission).toBeGreaterThan(0);
  });

  it('should execute a trade successfully with VIP tier (tierId=3)', async () => {
    const result = await executeTrade({ ...validTradeData, tierId: 3 });

    expect(result.success).toBe(true);
    // VIP tier has 0.10% rate and $0.00 minimum fee
    expect(typeof result.fee).toBe('number');
    expect(typeof result.commission).toBe('number');
  });

  it('should calculate correct commission for standard tier', async () => {
    // Standard tier: rate=0.50%, minFee=$4.95
    // tradeValue = 10 * 227.63 = 2276.30
    // fee = max(2276.30 * 0.005, 4.95) = max(11.3815, 4.95) = 11.3815 → rounded to 11.38
    const result = await executeTrade(validTradeData);

    expect(result.fee).toBe(11.38);
    expect(result.commission).toBe(11.38);
  });

  it('should apply minimum fee when trade value is small', async () => {
    // Standard tier: minFee=$4.95
    // tradeValue = 1 * 1.00 = 1.00
    // fee = max(1.00 * 0.005, 4.95) = max(0.005, 4.95) = 4.95
    const result = await executeTrade({
      ...validTradeData,
      quantity: 1,
      price: 1.00,
    });

    expect(result.fee).toBe(4.95);
    expect(result.commission).toBe(4.95);
  });

  it('should handle sell side correctly (total = tradeValue - fee)', async () => {
    const result = await executeTrade({ ...validTradeData, side: 'sell' });

    const tradeValue = validTradeData.quantity * validTradeData.price;
    expect(result.total).toBeLessThan(tradeValue);
    expect(result.side).toBe('sell');
  });

  it('should handle buy side correctly (total = tradeValue + fee)', async () => {
    const result = await executeTrade(validTradeData);

    const tradeValue = validTradeData.quantity * validTradeData.price;
    expect(result.total).toBeGreaterThan(tradeValue);
    expect(result.side).toBe('buy');
  });

  it('should handle string tierId from form input (tierId="1")', async () => {
    // The frontend sends tierId as a string from the select element
    const result = await executeTrade({ ...validTradeData, tierId: '1' });

    expect(result.success).toBe(true);
    expect(result.fee).toBeGreaterThan(0);
  });
});

describe('COMMISSION_TIERS', () => {
  it('should have entries for standard, active, and vip tiers', () => {
    expect(COMMISSION_TIERS.has('standard')).toBe(true);
    expect(COMMISSION_TIERS.has('active')).toBe(true);
    expect(COMMISSION_TIERS.has('vip')).toBe(true);
  });

  it('should not match capitalized tier labels (regression test for case mismatch bug)', () => {
    // The original bug was caused by resolveTierLabel returning 'Standard'
    // while the Map keys were 'standard'. This ensures the Map uses lowercase keys.
    expect(COMMISSION_TIERS.has('Standard')).toBe(false);
    expect(COMMISSION_TIERS.has('Active Trader')).toBe(false);
    expect(COMMISSION_TIERS.has('VIP')).toBe(false);
  });
});
