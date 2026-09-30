/* global describe, expect, test */

const fixtures = require('./fixtures/513ad458-tax-fixtures.json');
const {
  computeJurisdictionTax,
  JURISDICTIONS,
} = require('../app/services/verticals/513ad458');

describe('Vertex jurisdiction rate fixtures', () => {
  test.each(fixtures)('$jurisdiction matches its golden tax fixture', (fixture) => {
    const result = computeJurisdictionTax(
      fixture.basis,
      JURISDICTIONS[fixture.jurisdiction],
      true,
    );

    expect(result.taxRate).toBeCloseTo(fixture.expectedTaxRate);
    expect(result.taxAmount).toBe(fixture.expectedTaxAmount);
    expect(result.lineItems).toHaveLength(fixture.expectedLines.length);
    result.lineItems.forEach((line, index) => {
      expect(line.authority).toBe(fixture.expectedLines[index].authority);
      expect(line.rate).toBeCloseTo(fixture.expectedLines[index].rate);
      expect(line.tax).toBe(fixture.expectedLines[index].tax);
    });
  });

  test('Nova Scotia HST is 15%', () => {
    expect(JURISDICTIONS['CA-NS'].authorities[0].rate).toBeCloseTo(0.15);
    expect(computeJurisdictionTax(10000, JURISDICTIONS['CA-NS'], true).taxAmount).toBe(1500);
  });
});
