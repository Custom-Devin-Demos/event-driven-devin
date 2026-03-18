// Mock uuid before requiring cpg.js so the ESM module is never loaded
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

// Mock telemetry dependencies so processOrder doesn't require live services
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

const { processOrder, CATALOG, WAREHOUSE_TIERS } = require('./cpg');

describe('processOrder — CPG distributor bulk order', () => {
  const validOrder = {
    distributorId: 'DIST-001',
    region: 'northeast',
    fulfillmentZone: 'southeast',
    items: [{ sku: 'BEV-001', qty: 50 }],
  };

  it('should process an order successfully without throwing', async () => {
    const result = await processOrder(validOrder);
    expect(result.success).toBe(true);
    expect(result.orderId).toBeDefined();
    expect(result.status).toBe('confirmed');
  });

  it('should return a valid fulfillmentHub derived from primaryHub', async () => {
    const result = await processOrder(validOrder);
    // fulfillmentHub must be one of the known hub codes from WAREHOUSE_TIERS
    const allHubs = WAREHOUSE_TIERS.flatMap((t) => t.hubs);
    expect(allHubs).toContain(result.fulfillmentHub);
  });

  it('should work for every fulfillment zone', async () => {
    const zones = WAREHOUSE_TIERS.map((t) => t.region);
    for (const zone of zones) {
      const result = await processOrder({ ...validOrder, fulfillmentZone: zone });
      expect(result.success).toBe(true);
      expect(result.fulfillmentHub).toBeDefined();
      expect(typeof result.fulfillmentHub).toBe('string');
    }
  });

  it('should not crash when fulfillmentZone does not match any region', async () => {
    const result = await processOrder({
      ...validOrder,
      fulfillmentZone: 'nonexistent-zone',
    });
    // Should still succeed by falling back to the highest-capacity warehouse
    expect(result.success).toBe(true);
    expect(result.fulfillmentHub).toBeDefined();
  });

  it('should calculate subtotal from the catalog', async () => {
    const result = await processOrder(validOrder);
    const product = CATALOG.find((p) => p.sku === 'BEV-001');
    expect(result.subtotal).toBe(Math.round(product.unitPrice * 50 * 100) / 100);
  });

  it('should handle multiple items in a single order', async () => {
    const result = await processOrder({
      ...validOrder,
      items: [
        { sku: 'BEV-001', qty: 10 },
        { sku: 'SNK-001', qty: 20 },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.fulfillmentHub).toBeDefined();
  });
});
