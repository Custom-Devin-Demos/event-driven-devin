/* global describe, expect, jest, test, beforeEach */

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn().mockResolvedValue(undefined),
}));

const { createSessionAndAlert } = require('../app/services/devin-session');
const { processQuote, lookupVehicle } = require('../app/services/verticals/b17bf9db');

const DRIVER = {
  firstName: 'Oliver', lastName: 'Bennett', dateOfBirth: '1986-06-14', postcode: 'LS1 4AP', occupation: 'Product Manager', licenceYears: 12,
};
const COVER = {
  type: 'comprehensive', annualMileage: 8000, voluntaryExcess: 250, ncdYears: 9,
};

function quote(registration) {
  return { vehicle: lookupVehicle(registration), driver: DRIVER, cover: COVER };
}

describe('Compare the Market car quote (b17bf9db)', () => {
  beforeEach(() => createSessionAndAlert.mockClear());

  test('electric car crashes the risk profile and alerts', async () => {
    await expect(processQuote(quote('EV24 TSL'))).rejects.toThrow(TypeError);
    expect(createSessionAndAlert).toHaveBeenCalledWith(expect.objectContaining({ customer: 'b17bf9db' }));
  });

  test('petrol car returns quotes sorted by annual price', async () => {
    const result = await processQuote(quote('FD21 KXP'));
    expect(result.success).toBe(true);
    expect(result.quotes).toHaveLength(6);
    const prices = result.quotes.map((q) => q.annualPrice);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
    expect(result.cheapest.insurer).toBe('1st Central');
    expect(createSessionAndAlert).not.toHaveBeenCalled();
  });

  test('registration lookup ignores spacing and case', () => {
    expect(lookupVehicle('hy23rav').model).toBe('RAV4');
    expect(lookupVehicle('ZZ99 ZZZ')).toBeNull();
  });

  test('third-party cover shows third-party products without comprehensive extras', async () => {
    const result = await processQuote({ ...quote('FD21 KXP'), cover: { ...COVER, type: 'tpo' } });
    expect(result.coverType).toBe('Third party only');
    result.quotes.forEach((q) => {
      expect(q.product).toMatch(/Third party only$/);
      expect(q.features).not.toContain('Courtesy car');
      expect(q.features).not.toContain('Windscreen cover');
    });
  });
});
