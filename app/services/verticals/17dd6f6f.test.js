const {
  processTrackShipment,
  buildDeliveryEstimate,
  buildTrackingSummary,
  computeShippingCost,
  getTrackingHistory,
  SHIPMENTS,
  SERVICE_LEVELS,
} = require('./17dd6f6f');

describe('17dd6f6f logistics — track shipment', () => {
  // Regression: FX-7829104563 (priority_overnight) has destination.facility = null,
  // so buildDeliveryEstimate never set estimate.deliveryWindow and buildTrackingSummary
  // threw "Cannot read properties of undefined (reading 'start')" (Sentry NODE-EXPRESS-2B).
  test('processTrackShipment succeeds for a priority_overnight shipment with no destination facility', async () => {
    const summary = await processTrackShipment({
      trackingNumber: 'FX-7829104563',
      serviceType: 'priority_overnight',
    });

    expect(summary.trackingNumber).toBe('FX-7829104563');
    expect(summary.service).toBe('FedEx Priority Overnight');
    expect(summary.deliveryWindow).toBe('8:00 AM - 10:30 AM');
    expect(summary.totalCost).toMatch(/^\$\d/);
  });

  test('buildDeliveryEstimate always returns a delivery window even when destination.facility is null', () => {
    const shipment = SHIPMENTS.find((s) => s.trackingNumber === 'FX-7829104563');
    expect(shipment.destination.facility).toBeNull();

    const estimate = buildDeliveryEstimate(shipment);
    expect(estimate.deliveryWindow).toBeDefined();
    expect(estimate.deliveryWindow.start).toBe('8:00 AM');
    expect(estimate.deliveryWindow.end).toBe('10:30 AM');
    expect(estimate.deliveryWindow.facility).toBeNull();
  });

  test('every service level produces a defined delivery window with string bounds', () => {
    for (const serviceType of Object.keys(SERVICE_LEVELS)) {
      const estimate = buildDeliveryEstimate({
        serviceType,
        destination: { facility: null },
      });
      expect(estimate.deliveryWindow).toBeDefined();
      expect(typeof estimate.deliveryWindow.start).toBe('string');
      expect(typeof estimate.deliveryWindow.end).toBe('string');
    }
  });

  test('buildTrackingSummary renders the window range and preserves the facility when present', () => {
    const shipment = SHIPMENTS.find((s) => s.trackingNumber === 'FX-3351908274');
    expect(shipment.destination.facility).toBe('AUS-DIST');

    const cost = computeShippingCost(shipment);
    const estimate = buildDeliveryEstimate(shipment);
    const history = getTrackingHistory(shipment);
    const summary = buildTrackingSummary(shipment, cost, estimate, history);

    expect(estimate.deliveryWindow.facility).toBe('AUS-DIST');
    expect(summary.deliveryWindow).toBe('8:00 AM - 8:00 PM');
    expect(summary.lastScan).toContain(' at ');
  });
});
