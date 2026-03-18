// Mock uuid before importing cpg module
jest.mock('uuid', () => ({
  v4: () => 'test-order-id-1234',
}));

const { processOrder, CATALOG, WAREHOUSE_TIERS } = require('./cpg');

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

describe('processOrder', () => {
  const validOrder = {
    distributorId: 'DIST-001',
    region: 'northeast',
    fulfillmentZone: 'southeast',
    items: [{ sku: 'BEV-001', qty: 50 }],
  };

  it('should successfully process a valid order', async () => {
    const result = await processOrder(validOrder);

    expect(result.success).toBe(true);
    expect(result.orderId).toBeDefined();
    expect(result.distributorId).toBe('DIST-001');
    expect(result.subtotal).toBeGreaterThan(0);
    expect(result.fulfillmentHub).toBeDefined();
    expect(typeof result.fulfillmentHub).toBe('string');
    expect(result.leadTimeDays).toBeDefined();
    expect(result.status).toBe('confirmed');
  });

  it('should return a valid hub code from the warehouse tiers', async () => {
    const result = await processOrder(validOrder);

    const allHubs = WAREHOUSE_TIERS.flatMap((t) => t.hubs);
    expect(allHubs).toContain(result.fulfillmentHub);
  });

  it('should select the preferred fulfillment zone hub when available', async () => {
    const order = { ...validOrder, fulfillmentZone: 'northeast' };
    const result = await processOrder(order);

    const northeastTier = WAREHOUSE_TIERS.find((t) => t.region === 'northeast');
    expect(result.fulfillmentHub).toBe(northeastTier.hubs[0]);
  });

  it('should handle all valid fulfillment zones without errors', async () => {
    const zones = ['northeast', 'southeast', 'midwest', 'west'];

    for (const zone of zones) {
      const order = { ...validOrder, fulfillmentZone: zone };
      const result = await processOrder(order);
      expect(result.success).toBe(true);
      expect(result.fulfillmentHub).toBeDefined();
    }
  });

  it('should fall back to highest-capacity hub for unknown fulfillment zone', async () => {
    const order = { ...validOrder, fulfillmentZone: 'unknown-zone' };
    const result = await processOrder(order);

    expect(result.success).toBe(true);
    expect(result.fulfillmentHub).toBeDefined();
  });

  it('should calculate correct subtotal from catalog prices', async () => {
    const order = {
      ...validOrder,
      items: [{ sku: 'BEV-001', qty: 10 }],
    };
    const result = await processOrder(order);

    const product = CATALOG.find((p) => p.sku === 'BEV-001');
    expect(result.subtotal).toBe(Math.round(product.unitPrice * 10 * 100) / 100);
  });

  it('should set lead time to 5 days for large orders (>200 units)', async () => {
    const order = {
      ...validOrder,
      items: [{ sku: 'BEV-001', qty: 250 }],
    };
    const result = await processOrder(order);

    expect(result.leadTimeDays).toBe(5);
  });

  it('should set lead time to 3 days for small orders (<=200 units)', async () => {
    const order = {
      ...validOrder,
      items: [{ sku: 'BEV-001', qty: 50 }],
    };
    const result = await processOrder(order);

    expect(result.leadTimeDays).toBe(3);
  });
});
