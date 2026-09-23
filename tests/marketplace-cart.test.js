const { addToCart, FULFILMENT_NODES, RESERVATION_DEADLINE_MS } = require('../app/services/oncall-verticals/marketplace');

jest.setTimeout(30000);

describe('marketplace cart reservation', () => {
  test('reserves from the stocked node within the deadline even when it is last in the walk', async () => {
    const started = Date.now();
    const result = await addToCart({
      offerId: 'OFF-NA221-PHG',
      sellerId: 'SELLER-PHILIPS-HHG',
      quantity: 1,
    });
    expect(result.success).toBe(true);
    expect(result.reservationRef).toMatch(/^RES-/);
    expect(Date.now() - started).toBeLessThan(RESERVATION_DEADLINE_MS);
  });

  test('reports OUT_OF_STOCK when no node can cover the quantity', async () => {
    const saved = FULFILMENT_NODES.map((n) => n.stock);
    FULFILMENT_NODES.forEach((n) => { n.stock = 0; });
    try {
      await expect(addToCart({ offerId: 'OFF-NA221-PHG', quantity: 1 }))
        .rejects.toMatchObject({ code: 'OUT_OF_STOCK' });
    } finally {
      FULFILMENT_NODES.forEach((n, i) => { n.stock = saved[i]; });
    }
  });

  test('rejects an unknown offer without probing any node', async () => {
    const started = Date.now();
    await expect(addToCart({ offerId: 'OFF-DOES-NOT-EXIST', quantity: 1 }))
      .rejects.toMatchObject({ code: 'OFFER_NOT_FOUND' });
    expect(Date.now() - started).toBeLessThan(500);
  });

  test('reserves from the stocked node once the node walk is short enough', async () => {
    const trimmed = FULFILMENT_NODES.splice(0, FULFILMENT_NODES.length - 2);
    try {
      const result = await addToCart({
        offerId: 'OFF-NA221-PHG',
        sellerId: 'SELLER-PHILIPS-HHG',
        quantity: 2,
      });
      expect(result.success).toBe(true);
      expect(result.quantity).toBe(2);
      expect(result.subtotalFormatted).toBe('158,00 €');
    } finally {
      FULFILMENT_NODES.unshift(...trimmed);
    }
  });
});
