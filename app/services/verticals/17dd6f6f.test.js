const {
  buildDeliveryEstimate,
  buildTrackingSummary,
  computeShippingCost,
  getTrackingHistory,
  resolveShipment,
  SHIPMENTS,
} = require('./17dd6f6f');

function summarize(shipment) {
  const cost = computeShippingCost(shipment);
  const estimate = buildDeliveryEstimate(shipment);
  const history = getTrackingHistory(shipment);
  return buildTrackingSummary(shipment, cost, estimate, history);
}

describe('buildTrackingSummary deliveryWindow handling', () => {
  test('does not throw and reports fallback when destination has no facility (regression for NODE-EXPRESS-2B)', () => {
    const shipment = resolveShipment('FX-7829104563');
    expect(shipment.destination.facility).toBeNull();

    let summary;
    expect(() => {
      summary = summarize(shipment);
    }).not.toThrow();

    expect(buildDeliveryEstimate(shipment).deliveryWindow).toBeUndefined();
    expect(summary.deliveryWindow).toBe('Not available');
    expect(summary.trackingNumber).toBe('FX-7829104563');
  });

  test('formats the delivery window when destination has a facility', () => {
    const shipment = resolveShipment('FX-3351908274');
    expect(shipment.destination.facility).toBe('AUS-DIST');

    const summary = summarize(shipment);
    const estimate = buildDeliveryEstimate(shipment);

    expect(estimate.deliveryWindow).toBeDefined();
    expect(summary.deliveryWindow).toBe(
      estimate.deliveryWindow.start + ' - ' + estimate.deliveryWindow.end
    );
  });

  test('every seeded shipment can be summarized without throwing', () => {
    for (const shipment of SHIPMENTS) {
      expect(() => summarize(shipment)).not.toThrow();
    }
  });
});
