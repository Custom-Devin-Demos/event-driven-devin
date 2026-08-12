const {
  processInsightsRequest,
  LOCATION_GROUPS,
  WEEKLY_LEDGER,
  loadGroupLedger,
  indexCostBuckets,
  computePrimeCost,
} = require('../app/services/verticals/87127748');

describe('P&L insights service (87127748)', () => {
  test('generates prime cost rows for the full-service group', async () => {
    const result = await processInsightsRequest({
      locationGroup: 'full-service',
      period: 'last-week',
    });

    expect(result.success).toBe(true);
    expect(result.summary.rows).toHaveLength(LOCATION_GROUPS['full-service'].length);
    result.summary.rows.forEach((row) => {
      expect(typeof row.primeCost).toBe('number');
      expect(Number.isNaN(row.primeCost)).toBe(false);
      expect(typeof row.primeCostPct).toBe('number');
    });
    expect(result.summary.totalSales).toBeGreaterThan(0);
  });

  test.each(Object.keys(LOCATION_GROUPS))('generates insights for the %s group', async (group) => {
    const result = await processInsightsRequest({ locationGroup: group, period: 'last-week' });
    expect(result.success).toBe(true);
    expect(result.summary.rows).toHaveLength(LOCATION_GROUPS[group].length);
  });

  test('falls back to full-service for an unknown location group', async () => {
    const result = await processInsightsRequest({ locationGroup: 'does-not-exist' });
    expect(result.success).toBe(true);
    expect(result.summary.rows.map((r) => r.location)).toEqual(
      LOCATION_GROUPS['full-service'],
    );
  });

  test('computePrimeCost reads the Map-based cost index', () => {
    const costIndex = indexCostBuckets(loadGroupLedger('full-service'));
    const location = LOCATION_GROUPS['full-service'][0];
    const ledger = WEEKLY_LEDGER[location];

    const row = computePrimeCost(costIndex, location);

    expect(row.primeCost).toBe(Number((ledger.foodCost + ledger.laborCost).toFixed(2)));
    expect(row.primeCostPct).toBe(
      Number((((ledger.foodCost + ledger.laborCost) / ledger.netSales) * 100).toFixed(1)),
    );
  });

  test('computePrimeCost throws a descriptive error for an unindexed location', () => {
    const costIndex = indexCostBuckets(loadGroupLedger('full-service'));

    expect(() => computePrimeCost(costIndex, 'Nowhere Cafe')).toThrow(
      /No cost bucket indexed for location "Nowhere Cafe"/,
    );
  });

  test('every configured location has a weekly ledger entry', () => {
    Object.values(LOCATION_GROUPS)
      .flat()
      .forEach((location) => {
        expect(WEEKLY_LEDGER[location]).toBeDefined();
      });
  });
});
