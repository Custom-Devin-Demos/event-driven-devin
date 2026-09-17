/* global expect, test */

const { OPERATOR_SCHEMAS } = require('../app/services/verticals/a693dab5-operator-schemas');

const CANONICAL_COLUMNS = [
  'flightDate',
  'legId',
  'aircraftReg',
  'esn',
  'egtMarginC',
  'vibrationN1',
  'vibrationN2',
  'oilPressureKpa',
  'oilConsumptionQtHr',
  'altitudeFt',
];

test.each(Object.values(OPERATOR_SCHEMAS))('%s manifest satisfies the schema contract', (schema) => {
  CANONICAL_COLUMNS.forEach((column) => {
    expect(schema.columns[column]).toBeDefined();
  });
  if (!schema.units || !schema.units.egt) {
    throw new Error(`expected ${schema.code} manifest to declare units.egt`);
  }
  expect(['C', 'F']).toContain(schema.units.egt);
  if (!schema.units.oilPressure) {
    throw new Error(`expected ${schema.code} manifest to declare units.oilPressure`);
  }
  expect(['kPa', 'psi']).toContain(schema.units.oilPressure);
});
