const { processPreorder } = require('./f2f54159');

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

const VALID_PREORDER = {
  firstName: 'Marcus',
  lastName: 'Chen',
  email: 'marcus.chen@outlook.com',
  productLine: 'marvel-legends',
  quantity: 1,
  region: 'us-contiguous',
  membership: 'standard',
};

describe('processPreorder', () => {
  it('should successfully process a marvel-legends preorder', async () => {
    const result = await processPreorder(VALID_PREORDER);

    expect(result).toBeDefined();
    expect(result.productLine).toBe('Marvel Legends');
    expect(result.productId).toBe('marvel-legends');
    expect(result.quantity).toBe(1);
    expect(result.inventory).toBeDefined();
    expect(result.inventory.warehouse).toBe('us-east-1');
    expect(result.shipping).toBeDefined();
    expect(result.pricing).toBeDefined();
    expect(result.orderId).toBeDefined();
    expect(result.estimatedShipDate).toBeDefined();
  });

  it('should return correct warehouse for each product line', async () => {
    const productLines = [
      { id: 'marvel-legends', expectedWarehouse: 'us-east-1' },
      { id: 'transformers-gen', expectedWarehouse: 'us-west-2' },
      { id: 'star-wars-black', expectedWarehouse: 'us-east-1' },
      { id: 'gi-joe-classified', expectedWarehouse: 'us-central-1' },
      { id: 'ghostbusters-plasma', expectedWarehouse: 'us-east-1' },
      { id: 'power-rangers-lightning', expectedWarehouse: 'us-west-2' },
    ];

    for (const { id, expectedWarehouse } of productLines) {
      const result = await processPreorder({ ...VALID_PREORDER, productLine: id });
      expect(result.inventory.warehouse).toBe(expectedWarehouse);
    }
  });

  it('should handle unknown product line by falling back to default', async () => {
    const result = await processPreorder({
      ...VALID_PREORDER,
      productLine: 'unknown-product',
    });

    expect(result).toBeDefined();
    expect(result.productLine).toBe('Marvel Legends');
    expect(result.inventory.warehouse).toBe('unknown');
  });

  it('should include all required response fields', async () => {
    const result = await processPreorder(VALID_PREORDER);

    expect(result).toHaveProperty('productLine');
    expect(result).toHaveProperty('productId');
    expect(result).toHaveProperty('quantity');
    expect(result).toHaveProperty('fulfillable');
    expect(result).toHaveProperty('inventory.available');
    expect(result).toHaveProperty('inventory.allocationPct');
    expect(result).toHaveProperty('inventory.warehouse');
    expect(result).toHaveProperty('shipping.method');
    expect(result).toHaveProperty('shipping.cost');
    expect(result).toHaveProperty('shipping.estimatedDays');
    expect(result).toHaveProperty('pricing');
    expect(result).toHaveProperty('estimatedShipDate');
    expect(result).toHaveProperty('waveInfo.waveSize');
    expect(result).toHaveProperty('waveInfo.buildAFigure');
    expect(result).toHaveProperty('orderId');
    expect(result).toHaveProperty('customer');
  });
});
