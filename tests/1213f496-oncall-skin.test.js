/* global afterAll, beforeAll, describe, expect, fetch, jest, test */

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 's', url: 'https://app.devin.ai/sessions/s' }),
}));

const express = require('express');
const http = require('http');

const oncallRoutes = require('../app/routes/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const { checkoutOrder } = require('../app/services/oncall-verticals/grocery');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

describe('1213f496 grocery cart On-Call skin', () => {
  test('is a native grocery skin without the demo ribbon', () => {
    const skin = getOncallSkin('1213f496');
    expect(skin).toMatchObject({
      vertical: 'grocery',
      hideRibbon: true,
      oncallOnly: true,
      page: { file: '1213f496.html', title: 'Tu carrito | Rappi' },
    });
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A [A-Z& ]+ SITE — internal demo only/);
  });

  test('serves the shimmed cart page with the checkout form', async () => {
    const res = await fetch(`${baseUrl}/oncall/c/1213f496`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Tu carrito | Rappi</title>');
    expect(html).toContain("fetch('/api/grocery/checkout'");
    expect(html).toContain('/api/oncall/grocery/checkout');
    ['cartForm', 'placeOrderBtn', 'result'].forEach((id) => expect(html).toContain(`id="${id}"`));
  });

  test('cart lines only use SKUs the checkout can price', async () => {
    const res = await fetch(`${baseUrl}/oncall/c/1213f496`);
    const html = await res.text();
    const skus = [...html.matchAll(/\{ sku: '([^']+)', quantity: (\d+) \}/g)]
      .map(([, sku, quantity]) => ({ sku, quantity: Number(quantity) }));
    expect(skus.map((l) => l.sku)).toEqual(['21004836_EA', '20083157_KG', '20135377001_KG']);
    const order = await checkoutOrder({ storeId: '1039', lines: skus, pickupSlot: '2026-11-18T18:30' });
    expect(order).toMatchObject({ success: true, subtotal: 40.5, total: 41.8 });
  });
});
