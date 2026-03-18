// Mock uuid before requiring the module under test
jest.mock('uuid', () => ({
  v4: () => 'test-uuid-1234',
}));

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

const { processOrder, CATALOG, WAREHOUSE_TIERS } = require('./cpg');

describe('processOrder', () => {
  const validOrder = {
    distributorId: 'DIST-001',
    region: 'northeast',
    fulfillmentZone: 'northeast',
    items: [
      { sku: 'BEV-001', qty: 50 },
      { sku: 'SNK-001', qty: 30 },
    ],
  };

  it('should process an order successfully without TypeError on hub.origin.code', async () => {
    const result = await processOrder(validOrder);

    expect(result.success).toBe(true);
    expect(result.orderId).toBeDefined();
    expect(result.distributorId).toBe('DIST-001');
    expect(result.fulfillmentHub).toBeDefined();
    expect(typeof result.fulfillmentHub).toBe('string');
    expect(result.fulfillmentHub.length).toBe(3);
    expect(result.status).toBe('confirmed');
  });

  it('should use the correct primaryHub from the selected fulfillment hub', async () => {
    const result = await processOrder({
      ...validOrder,
      fulfillmentZone: 'northeast',
    });

    // Northeast preferred hub is 'NYC' (first hub in the northeast tier)
    expect(result.fulfillmentHub).toBe('NYC');
  });

  it('should handle different fulfillment zones correctly', async () => {
    const zones = ['northeast', 'southeast', 'midwest', 'west'];
    const expectedHubs = ['NYC', 'ATL', 'CHI', 'LAX'];

    for (let i = 0; i < zones.length; i++) {
      const result = await processOrder({
        ...validOrder,
        fulfillmentZone: zones[i],
      });
      expect(result.fulfillmentHub).toBe(expectedHubs[i]);
    }
  });

  it('should fall back to highest-capacity hub when fulfillmentZone does not match any region', async () => {
    const result = await processOrder({
      ...validOrder,
      fulfillmentZone: 'unknown-zone',
    });

    expect(result.success).toBe(true);
    expect(result.fulfillmentHub).toBeDefined();
    // Should pick the highest capacity hub (northeast with 50000 capacity)
    expect(result.fulfillmentHub).toBe('NYC');
  });

  it('should calculate subtotal and weight correctly', async () => {
    const result = await processOrder({
      ...validOrder,
      items: [{ sku: 'BEV-001', qty: 10 }],
    });

    expect(result.success).toBe(true);
    expect(result.subtotal).toBe(189.9); // 18.99 * 10
    expect(result.totalWeight).toBe(225); // 22.5 * 10
  });

  it('should set estimatedDays based on totalUnits', async () => {
    // Small order (< 200 units) => 3 days
    const smallResult = await processOrder({
      ...validOrder,
      items: [{ sku: 'BEV-001', qty: 50 }],
    });
    expect(smallResult.leadTimeDays).toBe(3);

    // Large order (> 200 units) => 5 days
    const largeResult = await processOrder({
      ...validOrder,
      items: [{ sku: 'BEV-001', qty: 250 }],
    });
    expect(largeResult.leadTimeDays).toBe(5);
  });
});
