jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');

const oncallRoutes = require('../app/routes/oncall');
const oncallVerticalRoutes = require('../app/routes/oncall-verticals');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');
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

const TITLE = 'Shopping Bag | Gap';
const ITEMS = [
  { sku: 'GAP-441020', qty: 1, shippingMethod: 'standard' },
  { sku: 'GAP-772045', qty: 1, shippingMethod: 'standard' },
];

describe('9e3a1e21 shopping bag on-call skin', () => {
  test('is a native storepickup skin without report or incident surfaces', () => {
    const skin = getOncallSkin('9e3a1e21');
    expect(skin).toMatchObject({ vertical: 'storepickup', oncallOnly: true, alertDestination: 'slack', page: { file: '9e3a1e21.html', title: TITLE } });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.devinSession).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A GAP SITE/);
    expect(Object.keys(skin.theme)).toEqual(['--accent', '--ink', '--surface', '--chrome-bg', '--chrome-text']);
    expect(ALERT_SCENARIOS.storepickup).toMatchObject({
      apiPath: '/api/f813dd7a/checkout',
      oncallApiPath: '/api/oncall/storepickup/checkout',
      triggerWhen: { fulfillment: 'pickup' },
    });
    expect(JSON.stringify(skin)).not.toMatch(/\.js|TypeError|NEARBY_STORES|STORE_HOLD|serial/i);
  });

  test('skin URL serves the shimmed page and unknown slugs or surfaces 404', async () => {
    const res = await fetch(`${baseUrl}/oncall/c/9e3a1e21`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/f813dd7a/checkout'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/storepickup/checkout"');
    expect(html).toMatch(/value="pickup" checked/);
    expect(html).not.toContain('class="back-link"');
    expect((await fetch(`${baseUrl}/9e3a1e21`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/oncall/c/9e3a1e22`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/oncall/c/9e3a1e21/report`)).status).toBe(404);
    expect((await fetch(`${baseUrl}/oncall/c/9e3a1e21/incident`)).status).toBe(404);
  });

  test('ship to address checks out the page bag at the page estimate', async () => {
    const res = await post('/api/oncall/storepickup/checkout', { items: ITEMS, promoCode: 'FRIENDS40', zipCode: '94108', channel: 'web' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, fulfillment: 'ship', subtotal: 169.9, savings: 67.96, shipping: 0, tax: 9.05, total: 110.99 });
  });
});
