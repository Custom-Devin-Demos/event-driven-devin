/* global afterAll, beforeAll, describe, expect, fetch, jest, test */

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

const TITLE = 'Bookbuild | Barrenjoey Front Office';
const ORDER = { dealId: 'CSR-PLC-2611', demandAud: 40, orderType: 'strike' };

describe('53e4e7e3 bookbuild order entry on-call skin', () => {
  test('is a native, Slack-routed bookbuild skin with a brand-free alert card', () => {
    const skin = getOncallSkin('53e4e7e3');
    expect(skin).toMatchObject({
      vertical: 'bookbuild',
      oncallOnly: true,
      alertDestination: 'slack',
      paths: ['/barrenjoey', '/barrenjoey-oncall'],
      devinSession: { auto: true },
      page: { file: '53e4e7e3.html', title: TITLE },
      theme: { '--accent': '#D58A5D' },
    });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A BARRENJOEY SITE/);
    Object.values(skin.alertCard).forEach((value) => expect(value).not.toMatch(/barrenjoey/i));
    const scenario = ALERT_SCENARIOS.bookbuild;
    expect(scenario).toMatchObject({
      apiPath: '/api/53e4e7e3/orders',
      oncallApiPath: '/api/oncall/bookbuild/orders',
      triggerWhen: { investorId: 'LPC-HK-0193' },
      alertOnStatus: [500],
      unlisted: true,
    });
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|SELLING_RESTRICTIONS|HK-PI/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/53e4e7e3', '/53e4e7e3', '/barrenjoey', '/barrenjoey-oncall'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/53e4e7e3/orders'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/bookbuild/orders"');
    expect(html).toContain('const triggerWhen = {"investorId":"LPC-HK-0193"}');
    expect(html).toContain('NOT ACTUALLY A BARRENJOEY SITE');
    expect(html).toMatch(/<option value="LPC-HK-0193"[^>]* selected>/);
    ['orderForm', 'dealId', 'investorId', 'demandAud', 'limitPrice', 'submitBtn', 'result']
      .forEach((id) => expect(html).toContain(`id="${id}"`));
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('report and incident surfaces 404', async () => {
    for (const p of ['/oncall/c/53e4e7e3/report', '/oncall/c/53e4e7e3/incident']) {
      expect((await fetch(`${baseUrl}${p}`)).status).toBe(404);
    }
  });

  test('the prefilled Hong Kong order fails with a 500, other jurisdictions go into the book', async () => {
    const broken = await post('/api/oncall/bookbuild/orders', { ...ORDER, investorId: 'LPC-HK-0193' });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toMatchObject({ success: false, errorClass: 'TypeError', code: 'BOOKBUILD_ORDER_FAILED' });

    for (const investorId of ['HPS-AU-0042', 'KRC-NZ-0117', 'TRA-UK-0088', 'MBI-SG-0071', 'GLE-US-0205']) {
      const ok = await post('/api/oncall/bookbuild/orders', { ...ORDER, investorId });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ success: true, status: 'IN_BOOK', shares: 10389610 });
    }

    const limit = await post('/api/oncall/bookbuild/orders', {
      ...ORDER, investorId: 'GLE-US-0205', orderType: 'limit', limitPrice: 3.8,
    });
    expect(await limit.json()).toMatchObject({ orderType: 'limit', limitPrice: 3.8, shares: 10526315 });
    expect((await post('/api/oncall/bookbuild/orders', {
      ...ORDER, investorId: 'GLE-US-0205', orderType: 'limit', limitPrice: 3.5,
    })).status).toBe(400);
    expect((await post('/api/oncall/bookbuild/orders', { ...ORDER, investorId: 'HPS-AU-0042', demandAud: 0 })).status).toBe(400);
    expect((await post('/api/oncall/bookbuild/orders', { ...ORDER, investorId: 'XXX-AU-0001' })).status).toBe(404);
    expect((await post('/api/oncall/bookbuild/orders', { ...ORDER, dealId: 'NOPE', investorId: 'HPS-AU-0042' })).status).toBe(404);
  });
});
