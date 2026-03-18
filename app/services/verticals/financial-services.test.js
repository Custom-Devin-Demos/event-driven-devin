const { executeTrade, COMMISSION_TIERS } = require('./financial-services');

// Mock uuid (ESM package) and other dependencies to isolate unit tests
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

describe('executeTrade', () => {
  const validTradeData = {
    symbol: 'AAPL',
    side: 'buy',
    quantity: 10,
    price: 227.63,
    tierId: 1,
    accountId: 'ACCT-INV-001',
  };

  it('should execute a standard tier trade successfully', async () => {
    const result = await executeTrade(validTradeData);

    expect(result.success).toBe(true);
    expect(result.symbol).toBe('AAPL');
    expect(result.side).toBe('buy');
    expect(result.quantity).toBe(10);
    expect(result.price).toBe(227.63);
    expect(result.status).toBe('filled');
    expect(result.tradeId).toBeDefined();
    expect(result.fee).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(0);
  });

  it('should calculate correct fee for standard tier (tierId=1)', async () => {
    const result = await executeTrade(validTradeData);
    const tradeValue = validTradeData.quantity * validTradeData.price;
    const standardTier = COMMISSION_TIERS.get('standard');
    const expectedFee = Math.max(tradeValue * standardTier.rate, standardTier.minFee);

    expect(result.fee).toBe(Math.round(expectedFee * 100) / 100);
  });

  it('should execute a trade for active tier (tierId=2)', async () => {
    const result = await executeTrade({ ...validTradeData, tierId: 2 });

    expect(result.success).toBe(true);
    const tradeValue = validTradeData.quantity * validTradeData.price;
    const activeTier = COMMISSION_TIERS.get('active');
    const expectedFee = Math.max(tradeValue * activeTier.rate, activeTier.minFee);
    expect(result.fee).toBe(Math.round(expectedFee * 100) / 100);
  });

  it('should execute a trade for VIP tier (tierId=3)', async () => {
    const result = await executeTrade({ ...validTradeData, tierId: 3 });

    expect(result.success).toBe(true);
    const tradeValue = validTradeData.quantity * validTradeData.price;
    const vipTier = COMMISSION_TIERS.get('vip');
    const expectedFee = Math.max(tradeValue * vipTier.rate, vipTier.minFee);
    expect(result.fee).toBe(Math.round(expectedFee * 100) / 100);
  });

  it('should handle sell side trades correctly', async () => {
    const result = await executeTrade({ ...validTradeData, side: 'sell' });

    expect(result.success).toBe(true);
    expect(result.side).toBe('sell');
    // For sell, total = tradeValue - fee, so total should be less than tradeValue
    const tradeValue = validTradeData.quantity * validTradeData.price;
    expect(result.total).toBeLessThan(tradeValue);
  });

  it('should throw when tierId is invalid/undefined (original bug: null commission)', async () => {
    // This reproduces the original bug: an invalid tierId causes
    // resolveTierLabel to return undefined, getCommissionRate to return null,
    // and then commission.fees.base throws TypeError
    await expect(
      executeTrade({ ...validTradeData, tierId: 999 })
    ).rejects.toThrow();
  });

  it('should throw when tierId is null', async () => {
    await expect(
      executeTrade({ ...validTradeData, tierId: null })
    ).rejects.toThrow();
  });

  it('should throw when tierId is undefined', async () => {
    const { tierId, ...noTierId } = validTradeData;
    await expect(executeTrade(noTierId)).rejects.toThrow();
  });
});
