const { addToBag } = require('../app/services/oncall-verticals/apparel');

jest.setTimeout(30000);

describe('apparel bag', () => {
  test.each(['XX-Small', 'X-Small', 'Small', 'Medium', 'Large', 'X-Large', 'XX-Large'])(
    'fails fast for the page size label %s',
    async (size) => {
      const started = Date.now();
      let caught;
      try {
        await addToBag({ styleId: '8688977', size, color: 'Grey Dark Charcoal', quantity: 1 });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TypeError);
      expect(caught.message).toBe("Cannot read properties of undefined (reading 'sku')");
      expect(Date.now() - started).toBeLessThan(500);
    },
  );

  test('rejects an unknown style', async () => {
    await expect(addToBag({ styleId: 'unknown', size: 'M' }))
      .rejects.toMatchObject({ code: 'STYLE_NOT_FOUND' });
  });

  test('adds a catalog size code with USD subtotals', async () => {
    const one = await addToBag({ styleId: '8688977', size: 'M', quantity: 1 });
    expect(one.success).toBe(true);
    expect(one.sku).toBe('11150327-M');
    expect(one.subtotalFormatted).toBe('$169.00');

    const two = await addToBag({ styleId: '8688977', size: 'M', quantity: 2 });
    expect(two.quantity).toBe(2);
    expect(two.subtotalFormatted).toBe('$338.00');
  });
});
