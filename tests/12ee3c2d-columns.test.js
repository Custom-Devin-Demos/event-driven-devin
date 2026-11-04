/* global describe, expect, jest, test, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { saveColumnLayout, getPortal, DEFAULT_LAYOUT } = require('../app/services/verticals/12ee3c2d');

describe('American Express Merchant settlements columns (12ee3c2d)', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('adding Opening Debit Balance crashes the layout save and alerts', async () => {
    await expect(saveColumnLayout({ layout: [...DEFAULT_LAYOUT, 'opening_debit_balance'] })).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ customer: '12ee3c2d' }));
  });

  test('other inactive columns save and re-project the table', async () => {
    const layout = [...DEFAULT_LAYOUT, 'number_of_transactions', 'payee_merchant_number', 'payee_location_id'];
    const result = await saveColumnLayout({ layout });
    expect(result.success).toBe(true);
    expect(result.rows[0].values).toHaveLength(layout.length);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('portal exposes the picker catalog and default layout', () => {
    const portal = getPortal();
    expect(portal.columns).toHaveLength(15);
    expect(portal.defaultLayout).toHaveLength(11);
  });
});
