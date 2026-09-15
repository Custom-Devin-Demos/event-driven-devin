const { addToCart, FULFILMENT_NODES } = require('../app/services/oncall-verticals/marketplace');

jest.setTimeout(30000);

describe('marketplace cart reservation', () => {
  test('times out before reaching the node that holds the stock', async () => {
    await expect(addToCart({
      offerId: 'OFF-NA221-PHG',
      sellerId: 'SELLER-PHILIPS-HHG',
      quantity: 1,
    })).rejects.toMatchObject({ code: 'RESERVATION_TIMEOUT' });
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
