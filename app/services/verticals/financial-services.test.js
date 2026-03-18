const { executeTrade, COMMISSION_TIERS } = require('./financial-services');

// Mock dependencies to isolate unit tests
jest.mock('uuid', () => ({ v4: () => 'test-trade-id' }));
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

  it('should successfully execute a buy trade with standard tier (tierId=1)', async () => {
    const result = await executeTrade(validTradeData);

    expect(result.success).toBe(true);
    expect(result.tradeId).toBe('test-trade-id');
    expect(result.symbol).toBe('AAPL');
    expect(result.side).toBe('buy');
    expect(result.quantity).toBe(10);
    expect(result.status).toBe('filled');
    expect(result.fee).toBeGreaterThan(0);
    expect(result.total).toBeGreaterThan(result.quantity * result.price);
  });

  it('should successfully execute a sell trade', async () => {
    const sellData = { ...validTradeData, side: 'sell' };
    const result = await executeTrade(sellData);

    expect(result.success).toBe(true);
    expect(result.side).toBe('sell');
    expect(result.total).toBeLessThan(sellData.quantity * sellData.price);
  });

  it('should apply correct commission for active trader tier (tierId=2)', async () => {
    const activeTraderData = { ...validTradeData, tierId: 2 };
    const result = await executeTrade(activeTraderData);

    expect(result.success).toBe(true);
    const expectedRate = COMMISSION_TIERS.get('active').rate;
    const tradeValue = activeTraderData.quantity * activeTraderData.price;
    const expectedFee = Math.round(Math.max(tradeValue * expectedRate, COMMISSION_TIERS.get('active').minFee) * 100) / 100;
    expect(result.fee).toBe(expectedFee);
  });

  it('should apply correct commission for VIP tier (tierId=3)', async () => {
    const vipData = { ...validTradeData, tierId: 3 };
    const result = await executeTrade(vipData);

    expect(result.success).toBe(true);
    const expectedRate = COMMISSION_TIERS.get('vip').rate;
    const tradeValue = vipData.quantity * vipData.price;
    const expectedFee = Math.round(Math.max(tradeValue * expectedRate, COMMISSION_TIERS.get('vip').minFee) * 100) / 100;
    expect(result.fee).toBe(expectedFee);
  });

  it('should throw when tierId does not map to a valid tier (null commission)', async () => {
    const invalidTierData = { ...validTradeData, tierId: 999 };
    await expect(executeTrade(invalidTierData)).rejects.toThrow();
  });

  it('should throw when tierId is undefined', async () => {
    const noTierData = { ...validTradeData, tierId: undefined };
    await expect(executeTrade(noTierData)).rejects.toThrow();
  });

  it('should throw when tierId is null', async () => {
    const nullTierData = { ...validTradeData, tierId: null };
    await expect(executeTrade(nullTierData)).rejects.toThrow();
  });
});
