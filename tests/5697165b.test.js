const {
  processDeliveryEstimate,
  SHIPPING_METHODS,
  ZONE_RATES,
  REGION_ZONES,
} = require('../app/services/verticals/5697165b');

describe('Nordstrom delivery estimate service (5697165b)', () => {
  test('returns an estimate for standard shipping to the west coast', async () => {
    const result = await processDeliveryEstimate({
      methodId: 'standard',
      region: 'west-coast',
      orderTotal: 129,
    });

    expect(result.estimateId).toMatch(/^NORD-/);
    expect(result.method).toBe('Standard Shipping');
    expect(result.shippingCost).toBe(0);
    expect(result.deliveryDays).toBe(5);
    expect(result.currency).toBe('USD');
  });

  test('charges the zone base rate for express shipping under the free-ship threshold', async () => {
    const result = await processDeliveryEstimate({
      methodId: 'express',
      region: 'mountain',
      orderTotal: 40,
    });

    expect(result.shippingCost).toBe(ZONE_RATES[2].baseRate);
    expect(result.deliveryDays).toBe(2 + ZONE_RATES[2].transitDays);
  });

  test('falls back to standard shipping for an unknown method', async () => {
    const result = await processDeliveryEstimate({
      methodId: 'does-not-exist',
      region: 'east-coast',
      orderTotal: 200,
    });

    expect(result.method).toBe('Standard Shipping');
  });

  test('every shipping method serves at least one zone with negotiated rates', () => {
    for (const method of SHIPPING_METHODS) {
      expect(method.zones.some((z) => ZONE_RATES[z])).toBe(true);
    }
  });

  test('every region maps to a numeric delivery zone', () => {
    for (const zone of Object.values(REGION_ZONES)) {
      expect(typeof zone).toBe('number');
    }
  });
});
