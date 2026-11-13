jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');
const path = require('path');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');
const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const {
  checkoutOrder, PROVISIONING_REGIONS, ACTIVATION_DEADLINE_MS,
} = require('../app/services/oncall-verticals/wirelesscheckout');
const { Sentry } = require('../app/telemetry/sentry');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

jest.setTimeout(30000);

const ORDER = [
  { sku: 'VZ-DEV-IP18P-256', qty: 1, price: 0.01 },
  { sku: 'VZ-PLN-SIMPLICITY', qty: 1, price: 30 },
  { sku: 'VZ-ADD-VMP', qty: 1, price: 18 },
];

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  app.use(oncallVerticalRoutes);
  app.use(express.static(path.join(__dirname, '..', 'app', 'public'), { index: false }));
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

describe('Verizon wireless checkout on-call skin', () => {
  test('skin is Slack-routed over the legacy page with a release/team alert card', () => {
    const skin = getOncallSkin('7c2f91a4');
    expect(skin).toMatchObject({
      company: 'Verizon',
      vertical: 'wirelesscheckout',
      alertDestination: 'slack',
      paths: ['/verizon-oncall'],
      page: { file: '4e150e99.html', title: 'Verizon \u2014 Checkout' },
    });
    expect(skin.oncallOnly).toBeUndefined();
    expect(skin.devinSession).toBeUndefined();
    expect(skin.alertCard).toMatchObject({ release: 'wireless-checkout@5.4.0', team: 'wireless-checkout-oncall' });
    expect(Object.values(skin.alertCard).join(' ')).not.toMatch(/\.js|TypeError|PROMO-|register|region/i);
    expect(ALERT_SCENARIOS.wirelesscheckout).toMatchObject({
      apiPath: '/api/4e150e99/checkout',
      oncallApiPath: '/api/oncall/wirelesscheckout/checkout',
      unlisted: true,
    });
  });

  test('serves the shimmed page at /verizon-oncall and leaves /verizon unshimmed', async () => {
    const [skinned, friendly, legacy] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/7c2f91a4`),
      fetch(`${baseUrl}/verizon-oncall`),
      fetch(`${baseUrl}/verticals/4e150e99.html`),
    ]);
    expect([skinned.status, friendly.status, legacy.status]).toEqual([200, 200, 200]);
    const html = await skinned.text();
    expect(await friendly.text()).toEqual(html);
    expect(html).toContain('const oncallApiPath = "/api/oncall/wirelesscheckout/checkout"');
    expect(html).toContain('var skinAlertDestination = "slack"');
    expect(html).toContain('NOT ACTUALLY A VERIZON SITE');
    expect(html).toContain('body:has(#oncall-ribbon) .bug-hint');
    expect(await legacy.text()).not.toContain('oncallApiPath');
  });

  test('every new-line order times out activating the line', async () => {
    const started = Date.now();
    await expect(checkoutOrder({ items: ORDER, state: 'NY' })).rejects.toMatchObject({ code: 'ACTIVATION_TIMEOUT' });
    expect(Date.now() - started).toBeGreaterThanOrEqual(ACTIVATION_DEADLINE_MS - 100);
    expect(PROVISIONING_REGIONS).toHaveLength(8);
    expect(Sentry.captureException).toHaveBeenCalled();
  });

  test('route returns 504 for the activation timeout and 400 for invalid orders', async () => {
    const post = (body) => fetch(`${baseUrl}/api/oncall/wirelesscheckout/checkout`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const [timeout, empty, unknown, badState] = await Promise.all([
      post({ items: ORDER, state: 'NY' }),
      post({}),
      post({ items: [{ sku: 'PROMO-IPHONE-EVERY-YEAR-2026', qty: 1 }], state: 'NY' }),
      post({ items: ORDER, state: 'ZZ' }),
    ]);
    expect(timeout.status).toBe(504);
    expect(await timeout.json()).toMatchObject({ success: false, errorClass: 'GatewayTimeout', code: 'ACTIVATION_TIMEOUT' });
    expect([empty.status, unknown.status, badState.status]).toEqual([400, 400, 400]);
    expect(await unknown.json()).toMatchObject({ code: 'INVALID_ORDER' });
  });

  test('orders without a new line re-price from the catalog and complete quickly', async () => {
    const started = Date.now();
    const result = await checkoutOrder({ items: [{ sku: 'VZ-ADD-VMP', qty: 1, price: 0.01 }], state: 'NY' });
    expect(result).toMatchObject({ success: true, subtotal: 18, tax: 1.6, total: 19.6, activations: [] });
    expect(Date.now() - started).toBeLessThan(500);
  });
});
