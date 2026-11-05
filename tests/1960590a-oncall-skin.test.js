jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  app.use(oncallVerticalRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.closeAllConnections();
  server.close(() => stopGateway().then(() => done()));
});

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const TITLE = 'Calculate Shipping Rates | FedEx';
const MEMPHIS = { city: 'Memphis', stateOrProvinceCode: 'TN', postalCode: '38118', countryCode: 'US' };
const PACKAGES = [{ count: 1, weight: { value: 5, units: 'LB' }, dimensions: { length: 12, width: 10, height: 8, units: 'IN' } }];

function quote(recipient, extra = {}) {
  return post('/api/oncall/shippingrates/rates', {
    shipper: MEMPHIS, recipient, destinationCountry: recipient.countryCode, packaging: 'YOUR_PACKAGING', packages: PACKAGES, shipDate: '2026-11-06', ...extra,
  });
}

describe('1960590a FedEx Shipping Rates on-call skin', () => {
  test('is a native, unlisted shippingrates skin alerting to Slack without report or incident surfaces', () => {
    const skin = getOncallSkin('1960590a');
    expect(skin).toMatchObject({ vertical: 'shippingrates', oncallOnly: true, alertDestination: 'slack', page: { file: '1960590a.html', title: TITLE } });
    expect(skin.teamsAlerts).toBeUndefined();
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toBe('NOT ACTUALLY A FEDEX SITE \u2014 internal demo only, not affiliated with, endorsed by, or a real FedEx product.');
    expect(skin.alertCard).toMatchObject({ title: '5xx rate \u2014 Shipping Rates: Show rates', release: 'rating-web@2026.11.1', team: 'shipping-rates-oncall' });
    expect(skin.devinSession.promptAppendix).toContain('cc @Marcus Bell (shipping-rates-oncall)');
    const scenario = ALERT_SCENARIOS.shippingrates;
    expect(scenario).toMatchObject({
      apiPath: '/api/1960590a/rates', oncallApiPath: '/api/oncall/shippingrates/rates', triggerWhen: { destinationCountry: 'CA' }, unlisted: true,
    });
    expect(scenario.metricQuery).toContain('service:checkout-api');
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|INTL_ZONES|zoneCode/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/1960590a', '/1960590a', '/fedex', '/fedex-rates'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/1960590a/rates'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/shippingrates/rates"');
    expect(html).toContain('const triggerWhen = {"destinationCountry":"CA"}');
    expect(html).toContain('NOT ACTUALLY A FEDEX SITE');
    expect(html).toContain('value="Memphis, TN 38118, United States"');
    expect(html).toContain('value="Toronto, ON M5V 2T6, Canada"');
    expect(html).toContain('We\u2019re sorry, rates are unavailable right now.');
    expect(html).toContain('/verticals/1960590a/fedex.css');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:|Content-Security-Policy/);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/1960590a/report`),
      fetch(`${baseUrl}/oncall/c/1960590a/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('Show rates fails with a 500 TypeError for US to Canada', async () => {
    const res = await quote({ city: 'Toronto', stateOrProvinceCode: 'ON', postalCode: 'M5V 2T6', countryCode: 'CA' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, errorClass: 'TypeError', code: 'RATE_QUOTE_FAILED', error: 'Rates are unavailable right now.' });
  });

  test('Show rates returns every domestic service for Memphis to Austin', async () => {
    const res = await quote({ city: 'Austin', stateOrProvinceCode: 'TX', postalCode: '78701', countryCode: 'US' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, currency: 'USD', zone: '5', billableWeight: 7, shipDate: '2026-11-06' });
    expect(data.rates.map((r) => r.serviceType)).toEqual([
      'FIRST_OVERNIGHT', 'PRIORITY_OVERNIGHT', 'STANDARD_OVERNIGHT', 'FEDEX_2_DAY_AM', 'FEDEX_2_DAY', 'FEDEX_EXPRESS_SAVER', 'FEDEX_GROUND',
    ]);
    expect(data.rates[0]).toMatchObject({ deliveryDate: '2026-11-09', deliveryDay: 'Mon, Nov 9', deliveryTime: '8:00 AM' });
    data.rates.forEach((r) => expect(r.amount).toBeGreaterThan(0));
    const amounts = Object.fromEntries(data.rates.map((r) => [r.serviceType, r.amount]));
    expect(amounts.FIRST_OVERNIGHT).toBeGreaterThan(amounts.PRIORITY_OVERNIGHT);
    expect(amounts.FEDEX_EXPRESS_SAVER).toBeGreaterThan(amounts.FEDEX_GROUND);
  });

  test.each([
    ['Mexico City', 'MX', '06600'],
    ['London', 'GB', 'SW1A 1AA'],
  ])('Show rates returns international services for Memphis to %s', async (city, countryCode, postalCode) => {
    const res = await quote({ city, postalCode, countryCode });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(data.rates.map((r) => r.serviceType)).toEqual(['INTERNATIONAL_PRIORITY', 'INTERNATIONAL_ECONOMY']);
  });

  test('metric packages are converted to pounds and inches before pricing', async () => {
    const austin = { city: 'Austin', postalCode: '78701', countryCode: 'US' };
    const [imperial, metric] = await Promise.all([
      quote(austin).then((r) => r.json()),
      quote(austin, { packages: [{ count: 1, weight: { value: 2.268, units: 'KG' }, dimensions: { length: 30.48, width: 25.4, height: 20.32, units: 'CM' } }] }).then((r) => r.json()),
    ]);
    expect(metric.billableWeight).toBe(imperial.billableWeight);
    expect(metric.rates.map((r) => r.amount)).toEqual(imperial.rates.map((r) => r.amount));
  });

  test('more packages than a quote allows returns 400 instead of pricing fewer', async () => {
    const res = await quote({ city: 'Austin', postalCode: '78701', countryCode: 'US' }, { packages: [{ ...PACKAGES[0], count: 301 }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: 'INVALID_SHIPMENT' });
  });

  test('invalid package weight returns 400', async () => {
    const res = await quote({ city: 'Austin', postalCode: '78701', countryCode: 'US' }, { packages: [{ weight: { value: 0 } }] });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'INVALID_SHIPMENT' });
  });
});
