const fs = require('fs');
const path = require('path');
const { isAppReport, sourceFor, APP_SERVICE } = require('../app/services/verticals/ios-demos');
const customer = require('../config/customers/09026519');

const PAGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', '09026519.html'), 'utf8');

describe('Mi Orange web replica (/miorange, iOS demo 09026519)', () => {
  test('is reachable at the friendly aliases', () => {
    expect(customer.aliases).toEqual(expect.arrayContaining(['miorange', 'mi-orange']));
  });

  test('reports to the shared iOS demo bridge with the native client identity', () => {
    expect(PAGE).toContain("var SLUG = '09026519';");
    expect(PAGE).toContain("var REPORT_PATH = '/api/ios/' + SLUG + '/error';");
    expect(PAGE).toContain("source: 'ios-demos/' + SLUG + '/ios'");
    expect(PAGE).toContain("service: 'customer-ios-demo'");
    expect(PAGE).toContain("platform: 'web'");
    expect(isAppReport('09026519', { source: sourceFor('09026519'), service: APP_SERVICE })).toBe(true);
  });

  test('keeps the planted roaming defect: catalog zone IDs do not match tariff table keys', () => {
    const zoneIDs = [...PAGE.matchAll(/zoneID: '(zona-\d)'/g)].map((m) => m[1]);
    const tariffKeys = [...PAGE.matchAll(/^\s+(Z\d): \{ name:/gm)].map((m) => m[1]);
    expect(zoneIDs).toContain('zona-3');
    expect(tariffKeys).toEqual(['Z2', 'Z3']);
    expect(zoneIDs.some((zone) => tariffKeys.includes(zone))).toBe(false);
  });
});
