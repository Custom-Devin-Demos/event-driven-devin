const {
  processInsightsRequest,
  computePrimeCost,
  indexCostBuckets,
  loadGroupLedger,
  LOCATION_GROUPS,
  WEEKLY_LEDGER,
} = require('../app/services/verticals/87127748');

describe('Restaurant P&L insights service (87127748)', () => {
  test('returns prime cost rows for the full-service group (original failure case)', async () => {
    const result = await processInsightsRequest({
      locationGroup: 'full-service',
      period: 'last-week',
    });

    expect(result.success).toBe(true);
    expect(result.summary.rows).toHaveLength(LOCATION_GROUPS['full-service'].length);

    const downtown = result.summary.rows.find((r) => r.location === 'Downtown Bistro');
    expect(downtown.primeCost).toBe(50470.95);
    expect(downtown.primeCostPct).toBe(59.9);
    expect(result.summary.totalSales).toBeGreaterThan(0);
  });

  test('computes prime cost for every location group', async () => {
    for (const group of Object.keys(LOCATION_GROUPS)) {
      const result = await processInsightsRequest({ locationGroup: group });

      expect(result.summary.rows).toHaveLength(LOCATION_GROUPS[group].length);
      for (const row of result.summary.rows) {
        expect(Number.isFinite(row.primeCost)).toBe(true);
        expect(Number.isFinite(row.primeCostPct)).toBe(true);
      }
    }
  });

  test('falls back to full-service for an unknown or missing location group', async () => {
    const unknown = await processInsightsRequest({ locationGroup: 'not-a-group' });
    const missing = await processInsightsRequest({});

    expect(unknown.summary.rows.map((r) => r.location)).toEqual(
      LOCATION_GROUPS['full-service']
    );
    expect(missing.summary.rows).toHaveLength(LOCATION_GROUPS['full-service'].length);
  });

  test('every configured location has a weekly ledger entry', () => {
    for (const locations of Object.values(LOCATION_GROUPS)) {
      for (const name of locations) {
        expect(WEEKLY_LEDGER[name]).toBeDefined();
      }
    }
  });

  test('loadGroupLedger rejects a group containing a location with no ledger entry', () => {
    LOCATION_GROUPS['fast-casual'].push('Ghost Kitchen');
    try {
      expect(() => loadGroupLedger('fast-casual')).toThrow(
        /No weekly ledger entry for location "Ghost Kitchen"/
      );
    } finally {
      LOCATION_GROUPS['fast-casual'].pop();
    }
  });

  test('computePrimeCost reads the Map cost index by key', () => {
    const costIndex = indexCostBuckets([
      { name: 'Downtown Bistro', netSales: 1000, foodCost: 300, laborCost: 200 },
    ]);

    expect(computePrimeCost(costIndex, 'Downtown Bistro')).toEqual({
      location: 'Downtown Bistro',
      primeCost: 500,
      primeCostPct: 50,
    });
  });

  test('computePrimeCost throws a descriptive error for a location with no ledger entry', () => {
    const costIndex = indexCostBuckets([]);

    expect(() => computePrimeCost(costIndex, 'Ghost Kitchen')).toThrow(
      /No weekly ledger entry for location "Ghost Kitchen"/
    );
  });
});
