jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');
const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const { CATALOG } = require('../app/services/verticals/f813dd7a');

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

function post(urlPath, body) {
  return fetch(`${baseUrl}${urlPath}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const TITLE = 'RIVERSIDE SLICE CO. - DENVER, CO | Online Ordering | Clover';
const PAGE = fs.readFileSync(path.join(__dirname, '../app/public/verticals/8aab3fa1.html'), 'utf8');
const DEFAULT_CART = [
  { sku: 'GAP-885210', qty: 3, shippingMethod: 'standard' },
  { sku: 'GAP-772045', qty: 1, shippingMethod: 'standard' },
];

describe('8aab3fa1 Fiserv Clover online ordering on-call skin', () => {
  test('is a native Slack-routed storepickup skin triggered by Pickup', () => {
    const skin = getOncallSkin('8aab3fa1');
    expect(skin).toMatchObject({
      company: 'Fiserv',
      vertical: 'storepickup',
      oncallOnly: true,
      alertDestination: 'slack',
      paths: ['/fiserv-oncall', '/clover-oncall'],
      triggerWhen: { fulfillment: 'pickup' },
      page: { file: '8aab3fa1.html', title: TITLE },
    });
    expect(skin.devinSession).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A FISERV OR CLOVER SITE/);
    expect(ALERT_SCENARIOS.storepickup).toMatchObject({
      apiPath: '/api/f813dd7a/checkout',
      oncallApiPath: '/api/oncall/storepickup/checkout',
    });
    expect(JSON.stringify(skin)).not.toMatch(/\.js|TypeError|STORE_HOLD|serial/i);
  });

  test('friendly paths serve the shimmed page with Pickup preselected', async () => {
    for (const p of ['/fiserv-oncall', '/clover-oncall', '/oncall/c/8aab3fa1']) {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      const html = await res.text();
      expect(html).toContain(`<title>${TITLE}</title>`);
      expect(html).toContain("fetch('/api/f813dd7a/checkout'");
      expect(html).toContain('const oncallApiPath = "/api/oncall/storepickup/checkout"');
      expect(html).toMatch(/value="pickup" checked/);
    }
  });

  test('every menu item sends a SKU the shared checkout accepts', () => {
    const accepted = new Set(Object.values(CATALOG).map((p) => p.sku));
    const sent = [...PAGE.matchAll(/apiSku: '([^']+)'/g)].map((m) => m[1]);
    expect(sent.length).toBeGreaterThan(5);
    sent.forEach((sku) => expect(accepted.has(sku)).toBe(true));
    expect(PAGE).toContain("body.fulfillment = 'pickup'; body.storeNumber = STORE;");
  });

  test('Delivery checks out the default cart', async () => {
    const res = await post('/api/oncall/storepickup/checkout', { items: DEFAULT_CART, zipCode: '80202', channel: 'web' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, fulfillment: 'ship' });
    expect(data.orderId).toBeTruthy();
  });

  test('invalid carts return a structured 400', async () => {
    for (const items of [[], [{ sku: 'PIZZA-1', qty: 1 }], [{ sku: 'GAP-885210', qty: 11 }]]) {
      const res = await post('/api/oncall/storepickup/checkout', { items, zipCode: '80202' });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false });
    }
  });
});
