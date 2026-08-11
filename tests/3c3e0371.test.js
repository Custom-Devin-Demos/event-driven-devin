const {
  processStoreSearch,
  buildSlotIndex,
  rankStores,
  resolveMarket,
  MARKET_DIRECTORY,
} = require('../app/services/verticals/3c3e0371');

describe('Store search service (3c3e0371)', () => {
  test('returns ranked in-store pickup results for a Dallas zip', async () => {
    const result = await processStoreSearch({ zip: '75201', fulfillment: 'in-store' });

    expect(result.success).toBe(true);
    expect(result.market).toBe('Dallas Metro');
    expect(result.stores.length).toBe(3);
    expect(result.stores[0]).toMatchObject({ rank: 1, storeId: '35162', pickupSlots: 14 });
    for (const store of result.stores) {
      expect(store.storeId).toBeDefined();
      expect(store.address).toBeDefined();
    }
  });

  test('ranks stores by descending pickup slot count', async () => {
    const result = await processStoreSearch({ zip: '75201', fulfillment: 'in-store' });
    const slots = result.stores.map((s) => s.pickupSlots);

    expect(slots).toEqual([...slots].sort((a, b) => b - a));
  });

  test('fuel fulfillment only returns stores with fuel centers', async () => {
    const result = await processStoreSearch({ zip: '75201', fulfillment: 'fuel' });

    expect(result.stores.map((s) => s.storeId)).toEqual(['35162', '33410']);
  });

  test('buildSlotIndex exposes a stores array that rankStores can filter', () => {
    const index = buildSlotIndex(resolveMarket('10001'));

    expect(Array.isArray(index.stores)).toBe(true);
    expect(index.stores.length).toBe(index.byStore.size);
    expect(() => rankStores(index, 'in-store')).not.toThrow();
  });

  test('an unknown market yields an empty stores array instead of throwing', () => {
    const index = buildSlotIndex({ code: 'ZZZ', dcId: 'dc-000' });

    expect(index.stores).toEqual([]);
    expect(rankStores(index, 'in-store')).toEqual([]);
  });

  test('rankStores tolerates an index built without a stores array', () => {
    expect(rankStores({ byStore: new Map() }, 'in-store')).toEqual([]);
  });

  test('an unmapped zip falls back to the default market', async () => {
    const result = await processStoreSearch({ zip: '99999', fulfillment: 'in-store' });

    expect(result.market).toBe(MARKET_DIRECTORY[75].label);
    expect(result.stores.length).toBeGreaterThan(0);
  });
});
