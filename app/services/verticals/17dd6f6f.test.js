const {
  processTrackShipment,
  buildTrackingSummary,
  buildDeliveryEstimate,
  computeShippingCost,
  SERVICE_LEVELS,
  DELIVERY_WINDOWS,
} = require('./17dd6f6f');

describe('17dd6f6f logistics — track shipment', () => {
  // Regression: priority_overnight previously had no delivery window, so
  // buildTrackingSummary threw "Cannot read properties of undefined (reading 'start')".
  test('processTrackShipment succeeds for a priority_overnight shipment', async () => {
    const summary = await processTrackShipment({
      trackingNumber: 'FX-7829104563',
      serviceType: 'priority_overnight',
    });

    expect(summary.trackingNumber).toBe('FX-7829104563');
    expect(summary.serviceLevel).toBe('Priority Overnight');
    expect(summary.deliveryWindow).toBe('8:00 AM - 10:30 AM');
    expect(summary.totalCost).toMatch(/^\$\d/);
  });

  test('every service level resolves a delivery window (no undefined access)', () => {
    for (const [serviceType, level] of Object.entries(SERVICE_LEVELS)) {
      const estimate = buildDeliveryEstimate({ dimsIn: { length: 1, width: 1, height: 1 } }, level);
      expect(estimate.deliveryWindow).toBeDefined();
      expect(typeof estimate.deliveryWindow.start).toBe('string');
      expect(typeof estimate.deliveryWindow.end).toBe('string');
      expect(DELIVERY_WINDOWS[serviceType]).toBeDefined();
    }
  });

  test('buildDeliveryEstimate falls back to a default window for an unknown service level', () => {
    const estimate = buildDeliveryEstimate(
      { dimsIn: { length: 1, width: 1, height: 1 } },
      { transitDays: 3, windowKey: 'does_not_exist' },
    );
    expect(estimate.deliveryWindow).toBeDefined();
    expect(estimate.deliveryWindow.start).toBeDefined();
    expect(estimate.deliveryWindow.end).toBeDefined();
  });

  test('buildTrackingSummary renders the delivery window range', () => {
    const shipment = {
      trackingNumber: 'FX-0000000001',
      serviceType: 'priority_overnight',
    };
    const cost = computeShippingCost(
      { weightLbs: 10, dimsIn: { length: 12, width: 12, height: 12 } },
      SERVICE_LEVELS.priority_overnight,
    );
    const estimate = buildDeliveryEstimate(shipment, SERVICE_LEVELS.priority_overnight);
    const history = [{ description: 'Picked up', location: 'Memphis, TN' }];

    const summary = buildTrackingSummary(shipment, cost, estimate, history);
    expect(summary.deliveryWindow).toBe('8:00 AM - 10:30 AM');
    expect(summary.lastScan).toBe('Picked up at Memphis, TN');
  });
});
