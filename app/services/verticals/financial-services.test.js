// Mock uuid before importing the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-trade-id-1234',
}));

const { executeTrade, COMMISSION_TIERS } = require('./financial-services');

// Mock dependencies to isolate unit tests
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

describe('executeTrade', () => {
  const validTradeData = {
    symbol: 'AAPL',
    side: 'buy',
    quantity: 10,
    price: 227.63,
    tierId: 1,
    accountId: 'ACCT-INV-001',
  };

  it('should execute a trade successfully with tier 1 (standard)', async () => {
    const result = await executeTrade(validTradeData);

    expect(result.success).toBe(true);
    expect(result.symbol).toBe('AAPL');
    expect(result.side).toBe('buy');
    expect(result.quantity).toBe(10);
    expect(result.price).toBe(227.63);
    expect(result.status).toBe('filled');
    expect(typeof result.fee).toBe('number');
    expect(result.fee).toBeGreaterThan(0);
    expect(typeof result.total).toBe('number');
    expect(result.total).toBeGreaterThan(0);
    expect(result.filledAt).toBeDefined();
  });

  it('should execute a trade successfully with tier 2 (active trader)', async () => {
    const result = await executeTrade({ ...validTradeData, tierId: 2 });

    expect(result.success).toBe(true);
    expect(result.fee).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it('should execute a trade successfully with tier 3 (VIP)', async () => {
    const result = await executeTrade({ ...validTradeData, tierId: 3 });

    expect(result.success).toBe(true);
    // VIP has 0.00 minimum fee, so fee could be very small
    expect(typeof result.fee).toBe('number');
    expect(result.total).toBeGreaterThan(0);
  });

  it('should calculate correct fee for standard tier', async () => {
    const result = await executeTrade(validTradeData);
    const tradeValue = validTradeData.quantity * validTradeData.price;
    const standardRate = 0.0050;
    const standardMin = 4.95;
    const expectedFee = Math.round(Math.max(tradeValue * standardRate, standardMin) * 100) / 100;

    expect(result.fee).toBe(expectedFee);
  });

  it('should add fee for buy orders and subtract for sell orders', async () => {
    const buyResult = await executeTrade({ ...validTradeData, side: 'buy' });
    const sellResult = await executeTrade({ ...validTradeData, side: 'sell' });
    const tradeValue = validTradeData.quantity * validTradeData.price;

    expect(buyResult.total).toBeGreaterThan(tradeValue);
    expect(sellResult.total).toBeLessThan(tradeValue);
  });

  it('should throw an error when tierId is invalid (null)', async () => {
    await expect(
      executeTrade({ ...validTradeData, tierId: null })
    ).rejects.toThrow();
  });

  it('should throw an error when tierId is undefined', async () => {
    await expect(
      executeTrade({ ...validTradeData, tierId: undefined })
    ).rejects.toThrow();
  });

  it('should throw an error when tierId does not map to a valid tier', async () => {
    await expect(
      executeTrade({ ...validTradeData, tierId: 99 })
    ).rejects.toThrow();
  });
});

describe('COMMISSION_TIERS', () => {
  it('should have entries for standard, active, and vip tiers', () => {
    expect(COMMISSION_TIERS.has('standard')).toBe(true);
    expect(COMMISSION_TIERS.has('active')).toBe(true);
    expect(COMMISSION_TIERS.has('vip')).toBe(true);
  });

  it('should have rate and minFee for each tier', () => {
    for (const [, tier] of COMMISSION_TIERS) {
      expect(typeof tier.rate).toBe('number');
      expect(typeof tier.minFee).toBe('number');
    }
  });
});
