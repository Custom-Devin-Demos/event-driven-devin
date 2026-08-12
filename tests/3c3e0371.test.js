const {
  processStoreSearch,
  resolveMarket,
  buildSlotIndex,
  rankStores,
  STORE_CATALOG,
} = require('../app/services/verticals/3c3e0371');

describe('Acme store search service (3c3e0371)', () => {
  test('returns ranked stores for an in-store pickup search', async () => {
    const result = await processStoreSearch({
      zip: '75201',
      fulfillment: 'in-store',
    });

    expect(result.success).toBe(true);
    expect(result.market).toBe('Dallas Metro');
    expect(result.stores.length).toBe(3);
    for (const store of result.stores) {
      expect(typeof store.storeId).toBe('string');
      expect(store.address).toBeTruthy();
      expect(typeof store.pickupSlots).toBe('number');
    }
    expect(result.stores.map((s) => s.pickupSlots)).toEqual([14, 11, 9]);
  });

  test('buildSlotIndex exposes a stores array that rankStores can filter', () => {
    const index = buildSlotIndex(resolveMarket('75201'));

    expect(Array.isArray(index.stores)).toBe(true);
    expect(index.stores.length).toBe(STORE_CATALOG.DAL.length);
    expect(rankStores(index, 'in-store').length).toBe(STORE_CATALOG.DAL.length);
  });

  test('fuel fulfillment only returns stores with fuel service', async () => {
    const result = await processStoreSearch({
      zip: '10001',
      fulfillment: 'fuel',
    });

    expect(result.success).toBe(true);
    expect(result.stores).toEqual([]);
  });

  test('rankStores tolerates an index with no stores', () => {
    expect(rankStores({}, 'in-store')).toEqual([]);
    expect(rankStores({ stores: [] }, 'fuel')).toEqual([]);
  });

  test('unknown zip prefixes fall back to the Dallas market', async () => {
    const result = await processStoreSearch({
      zip: '99999',
      fulfillment: 'in-store',
    });

    expect(result.success).toBe(true);
    expect(result.market).toBe('Dallas Metro');
    expect(result.stores.length).toBeGreaterThan(0);
  });

  test('every market in the directory has a store catalog entry', () => {
    for (const market of Object.values(
      require('../app/services/verticals/3c3e0371').MARKET_DIRECTORY
    )) {
      expect(Array.isArray(STORE_CATALOG[market.code])).toBe(true);
    }
  });
});
