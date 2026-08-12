const {
  processInsightsRequest,
  LOCATION_GROUPS,
  WEEKLY_LEDGER,
  indexCostBuckets,
  computePrimeCost,
} = require('../app/services/verticals/87127748');

describe('Restaurant P&L insights service (87127748)', () => {
  test('generates prime cost rows for the full-service group', async () => {
    const result = await processInsightsRequest({
      locationGroup: 'full-service',
      period: 'last-week',
    });

    expect(result.success).toBe(true);
    expect(result.summary.rows).toHaveLength(LOCATION_GROUPS['full-service'].length);

    const downtown = result.summary.rows.find((r) => r.location === 'Downtown Bistro');
    const ledger = WEEKLY_LEDGER['Downtown Bistro'];
    const expectedPrime = Number((ledger.foodCost + ledger.laborCost).toFixed(2));
    expect(downtown.primeCost).toBe(expectedPrime);
    expect(downtown.primeCostPct).toBe(
      Number(((expectedPrime / ledger.netSales) * 100).toFixed(1))
    );
  });

  test.each(Object.keys(LOCATION_GROUPS))('generates insights for the %s group', async (group) => {
    const result = await processInsightsRequest({ locationGroup: group, period: 'last-week' });

    expect(result.success).toBe(true);
    expect(result.summary.rows).toHaveLength(LOCATION_GROUPS[group].length);
    result.summary.rows.forEach((row) => {
      expect(Number.isFinite(row.primeCost)).toBe(true);
      expect(Number.isFinite(row.primeCostPct)).toBe(true);
    });
  });

  test('reads the cost index as a Map rather than by property access', () => {
    const entries = LOCATION_GROUPS['quick-service'].map((name) => ({
      name,
      ...WEEKLY_LEDGER[name],
    }));
    const costIndex = indexCostBuckets(entries);

    expect(costIndex).toBeInstanceOf(Map);
    expect(costIndex['Midtown Express']).toBeUndefined();
    expect(computePrimeCost(costIndex, 'Midtown Express').location).toBe('Midtown Express');
  });

  test('throws a descriptive error instead of a TypeError for an unknown location', () => {
    const costIndex = indexCostBuckets([{ name: 'Downtown Bistro', ...WEEKLY_LEDGER['Downtown Bistro'] }]);

    expect(() => computePrimeCost(costIndex, 'Nowhere Cafe')).toThrow(
      /No weekly ledger entry for location "Nowhere Cafe"/
    );
    expect(() => computePrimeCost(costIndex, 'Nowhere Cafe')).not.toThrow(TypeError);
  });

  test('falls back to the full-service group for an unknown location group', async () => {
    const result = await processInsightsRequest({ locationGroup: 'not-a-group' });

    expect(result.success).toBe(true);
    expect(result.summary.rows.map((r) => r.location)).toEqual(LOCATION_GROUPS['full-service']);
  });
});
