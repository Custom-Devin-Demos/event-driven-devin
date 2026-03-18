// Mock uuid before requiring the module under test (avoids ESM import issue)
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
  const baseTrade = {
    symbol: 'AAPL',
    side: 'buy',
    quantity: 10,
    price: 227.63,
    tierId: 1,
    accountId: 'ACCT-INV-001',
  };

  it('should execute a trade successfully with standard tier (tierId=1)', async () => {
    const result = await executeTrade({ ...baseTrade, tierId: 1 });

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
  });

  it('should execute a trade successfully with active trader tier (tierId=2)', async () => {
    const result = await executeTrade({ ...baseTrade, tierId: 2 });

    expect(result.success).toBe(true);
    expect(result.status).toBe('filled');
    expect(typeof result.fee).toBe('number');
    expect(result.fee).toBeGreaterThan(0);
  });

  it('should execute a trade successfully with VIP tier (tierId=3)', async () => {
    const result = await executeTrade({ ...baseTrade, tierId: 3 });

    expect(result.success).toBe(true);
    expect(result.status).toBe('filled');
    expect(typeof result.fee).toBe('number');
    // VIP tier has minFee of 0, so fee could be very small but still calculated
    expect(result.fee).toBeGreaterThanOrEqual(0);
  });

  it('should calculate correct fee for standard tier', async () => {
    // Standard tier: rate 0.0050, minFee 4.95
    // tradeValue = 10 * 227.63 = 2276.30
    // calculated fee = 2276.30 * 0.0050 = 11.3815
    // Math.max(11.3815, 4.95) = 11.3815 → rounded to 11.38
    const result = await executeTrade({ ...baseTrade, tierId: 1 });

    expect(result.fee).toBe(11.38);
    // Buy: total = tradeValue + fee = 2276.30 + 11.38 = 2287.68
    expect(result.total).toBe(2287.68);
  });

  it('should apply minimum fee when calculated fee is below minimum', async () => {
    // Standard tier: rate 0.0050, minFee 4.95
    // Small trade: 1 share at $1.00 = tradeValue $1.00
    // calculated fee = 1.00 * 0.0050 = 0.005
    // Math.max(0.005, 4.95) = 4.95 (minimum fee applies)
    const result = await executeTrade({
      ...baseTrade,
      tierId: 1,
      quantity: 1,
      price: 1.0,
    });

    expect(result.fee).toBe(4.95);
  });

  it('should subtract fee from trade value for sell orders', async () => {
    const result = await executeTrade({ ...baseTrade, side: 'sell', tierId: 1 });

    // Sell: total = tradeValue - fee
    const tradeValue = 10 * 227.63;
    expect(result.total).toBe(Math.round((tradeValue - result.fee) * 100) / 100);
  });

  it('should correctly map all tier IDs to commission rates', () => {
    // Verify that the tier label mapping aligns with COMMISSION_TIERS keys
    expect(COMMISSION_TIERS.has('standard')).toBe(true);
    expect(COMMISSION_TIERS.has('active')).toBe(true);
    expect(COMMISSION_TIERS.has('vip')).toBe(true);
  });
});
