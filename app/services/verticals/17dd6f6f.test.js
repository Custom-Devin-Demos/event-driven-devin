jest.mock('uuid', () => ({ v4: () => '00000000-0000-0000-0000-000000000000' }));

const {
  resolveShipment,
  computeShippingCost,
  buildDeliveryEstimate,
  getTrackingHistory,
  buildTrackingSummary,
  SHIPMENTS,
} = require('./17dd6f6f');

function buildSummaryFor(trackingNumber) {
  const shipment = resolveShipment(trackingNumber);
  const cost = computeShippingCost(shipment);
  const estimate = buildDeliveryEstimate(shipment);
  const history = getTrackingHistory(shipment);
  return { shipment, summary: buildTrackingSummary(shipment, cost, estimate, history) };
}

describe('buildTrackingSummary', () => {
  test('does not throw for a shipment whose destination has no facility (default priority_overnight)', () => {
    // FX-7829104563 has destination.facility === null, so buildDeliveryEstimate
    // never sets estimate.deliveryWindow. This reproduces NODE-EXPRESS-2B.
    const shipment = SHIPMENTS.find((s) => s.trackingNumber === 'FX-7829104563');
    expect(shipment.destination.facility).toBeNull();

    const { summary } = buildSummaryFor('FX-7829104563');
    expect(summary.deliveryWindow).toBeNull();
    expect(summary.trackingNumber).toBe('FX-7829104563');
  });

  test('returns a formatted delivery window when the destination has a facility', () => {
    const { shipment, summary } = buildSummaryFor('FX-3351908274');
    expect(shipment.destination.facility).toBeTruthy();
    expect(typeof summary.deliveryWindow).toBe('string');
    expect(summary.deliveryWindow).toContain(' - ');
  });

  test('handles a missing deliveryWindow directly without throwing', () => {
    const estimate = {
      serviceLabel: 'FedEx Priority Overnight',
      guaranteedBy: '10:30 AM',
      estimatedDelivery: '2026-06-21T14:22:00Z',
      transitDays: 1,
      // deliveryWindow intentionally omitted
    };
    const shipment = SHIPMENTS[0];
    const cost = computeShippingCost(shipment);
    const history = getTrackingHistory(shipment);

    expect(() => buildTrackingSummary(shipment, cost, estimate, history)).not.toThrow();
    expect(buildTrackingSummary(shipment, cost, estimate, history).deliveryWindow).toBeNull();
  });
});
