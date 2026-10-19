jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');

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
  server.close(done);
});

function post(path, body) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const SKINS = [
  {
    slug: 'b33a7a98', vertical: 'fluidanalysis', title: 'Cummins MarketPlace', legacy: '/api/b33a7a98/cart', oncall: '/api/oncall/fluidanalysis/cart',
  },
  {
    slug: '35a59686', vertical: 'picklist', title: 'Genuine Cummins Parts', legacy: '/api/35a59686/picklist', oncall: '/api/oncall/picklist/add',
  },
  {
    slug: 'e8615789', vertical: 'esnlookup', title: 'Cummins QuickServe Online', legacy: '/api/e8615789/esn', oncall: '/api/oncall/esnlookup/lookup',
  },
];

describe('Cummins site on-call skins', () => {
  test.each(SKINS)('$slug is a native, unlisted $vertical skin', ({ slug, vertical, title, legacy, oncall }) => {
    expect(getOncallSkin(slug)).toMatchObject({ company: 'Cummins', vertical, oncallOnly: true, page: { file: `${slug}.html`, title } });
    const scenario = ALERT_SCENARIOS[vertical];
    expect(scenario).toMatchObject({ apiPath: legacy, oncallApiPath: oncall, unlisted: true });
    expect(JSON.stringify(scenario)).not.toMatch(/\.js|TypeError|PRICE_BOOKS|SERVICE_LIBRARY/);
  });

  test.each(SKINS)('$slug skin URL and direct slug serve the same shimmed page', async ({ slug, title, legacy, oncall }) => {
    const [skinned, direct] = await Promise.all([fetch(`${baseUrl}/oncall/c/${slug}`), fetch(`${baseUrl}/${slug}`)]);
    expect(skinned.status).toBe(200);
    const html = await skinned.text();
    expect(await direct.text()).toEqual(html);
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain(`fetch('${legacy}'`);
    expect(html).toContain(`const oncallApiPath = "${oncall}"`);
    expect(html).toContain('NOT ACTUALLY A CUMMINS SITE');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('the existing 7772b48a Cummins skin is unchanged', () => {
    expect(getOncallSkin('7772b48a')).toMatchObject({ vertical: 'marketplace', page: { file: '7772b48a.html' } });
  });

  test('Marketplace: dealer add-to-cart fails with a 500, distributor add-to-cart succeeds', async () => {
    const dealer = await post('/api/oncall/fluidanalysis/cart', { sku: 'DEOK-B-5', accountId: 'CMI-DLR-40817', quantity: 1 });
    expect(dealer.status).toBe(500);
    expect(await dealer.json()).toMatchObject({ success: false, errorClass: 'TypeError', code: 'CART_ADD_FAILED' });
    const distributor = await post('/api/oncall/fluidanalysis/cart', { sku: 'DEOK-B-5', accountId: 'CMI-DIST-10233', quantity: 2 });
    expect(distributor.status).toBe(200);
    expect(await distributor.json()).toMatchObject({ success: true, quantity: 2, unitPrice: 97.5, subtotal: 195 });
    expect((await post('/api/oncall/fluidanalysis/cart', { sku: 'NOPE', accountId: 'CMI-DIST-10233' })).status).toBe(400);
  });

  test('Parts: 3800984 fails with a 500, parts with shipment data add to the pick list', async () => {
    const broken = await post('/api/oncall/picklist/add', { partNumber: '3800984' });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toMatchObject({ success: false, errorClass: 'TypeError', code: 'PICKLIST_ADD_FAILED' });
    const ok = await post('/api/oncall/picklist/add', { partNumber: '4089650', quantity: 2 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ success: true, partNumber: '4089650', quantity: 2, freightClass: 'PARCEL' });
    expect((await post('/api/oncall/picklist/add', { partNumber: '0000000' })).status).toBe(404);
  });

  test('QSOL: ESN 79464646 fails with a 500, older ESNs list their manuals', async () => {
    const broken = await post('/api/oncall/esnlookup/lookup', { esn: '79464646' });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toMatchObject({ success: false, errorClass: 'TypeError', code: 'ESN_LOOKUP_FAILED' });
    const ok = await post('/api/oncall/esnlookup/lookup', { esn: '73283421' });
    expect(ok.status).toBe(200);
    const body = await ok.json();
    expect(body.engine.model).toBe('ISX15');
    expect(body.manuals).toHaveLength(3);
    expect((await post('/api/oncall/esnlookup/lookup', { esn: '12' })).status).toBe(400);
    expect((await post('/api/oncall/esnlookup/lookup', { esn: '11111111' })).status).toBe(404);
  });
});
