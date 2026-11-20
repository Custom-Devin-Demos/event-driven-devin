/* global describe, expect, jest, test, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { submitQuote, listBoms, getBom, unitPriceAt, orderQuantity, PARTS } = require('../app/services/verticals/c03fbe3d');

describe('Arrow.com BOM request for quote (c03fbe3d)', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('motor controller BOM with a Vietnam-origin part crashes duty estimate and alerts', async () => {
    await expect(submitQuote({ bomId: 'BOM-70412' })).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ customer: 'c03fbe3d' }));
  });

  test('sensor hub BOM quotes with duty per country of origin', async () => {
    const result = await submitQuote({ bomId: 'BOM-70388', quoteReference: 'SH-210' });
    expect(result.success).toBe(true);
    expect(result.partsQuoted).toBe(7);
    expect(result.total).toBeCloseTo(result.subtotal + result.estimatedDuty, 2);
    expect(result.lines.find((l) => l.mpn === 'C0805C475K4RACTU').estimatedDuty).toBe(0);
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('prices at quantity breaks and rounds to order multiples', () => {
    expect(unitPriceAt(PARTS['STM32F407VGT6'], 500)).toBe(9.18);
    expect(orderQuantity(PARTS['LT4256-2IS8#PBF'], 250)).toBe(300);
  });

  test('BOM list and results expose stock, lead time and supply data', () => {
    expect(listBoms().boms).toHaveLength(2);
    const bom = getBom('BOM-70412');
    expect(bom.lines).toHaveLength(12);
    expect(bom.counts.outOfStock).toBe(1);
    expect(bom.lines.find((l) => l.mpn === 'FDMS86180').leadTimeHistory.length).toBeGreaterThan(3);
  });
});
