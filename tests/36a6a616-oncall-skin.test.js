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

const TITLE = 'Checkout | Commerce Portal | myRockwell';
const CART = [
  { catalog: '9324-RLD300SUBENE', quantity: 12 },
  { catalog: '9324-RLDGLXSUBENE', quantity: 4 },
  { catalog: '9541-OPXSTDPROSUB', quantity: 2 },
  { catalog: 'TC-SW-STD-SUB', quantity: 1 },
];

describe('36a6a616 myRockwell Commerce Portal on-call skin', () => {
  test('is a native, unlisted softwarequote skin without report or incident surfaces', () => {
    const skin = getOncallSkin('36a6a616');
    expect(skin).toMatchObject({ vertical: 'softwarequote', oncallOnly: true, alertDestination: 'slack', page: { file: '36a6a616.html', title: TITLE } });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A ROCKWELL AUTOMATION SITE/);
    const scenario = ALERT_SCENARIOS.softwarequote;
    expect(scenario).toMatchObject({
      apiPath: '/api/36a6a616/quote', oncallApiPath: '/api/oncall/softwarequote/quote', triggerWhen: { agreementTerm: 'PREPAID_3Y' }, unlisted: true,
    });
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|PRICING_CONDITIONS|ZPP3|discountPct/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/36a6a616', '/36a6a616', '/commerce-portal', '/software-portal-oncall'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/36a6a616/quote'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/softwarequote/quote"');
    expect(html).toContain('const triggerWhen = {"agreementTerm":"PREPAID_3Y"}');
    expect(html).toContain('NOT ACTUALLY A ROCKWELL AUTOMATION SITE');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/36a6a616/report`),
      fetch(`${baseUrl}/oncall/c/36a6a616/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('Generate quote fails with a 500 TypeError for the 3-year prepaid term only', async () => {
    const res = await post('/api/oncall/softwarequote/quote', { agreementTerm: 'PREPAID_3Y', items: CART, customerPo: 'GLP-PO-2026-4471' });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data).toMatchObject({ success: false, errorClass: 'TypeError', code: 'QUOTE_FAILED' });
    expect(JSON.stringify(data)).not.toMatch(/discountPct|PRICING_CONDITIONS|ZPP3/);
  });

  test.each([
    ['ANNUAL_1Y', 1, 0],
    ['ANNUAL_3Y', 3, 5],
  ])('Generate quote creates a quote for %s', async (agreementTerm, years, discountPct) => {
    const res = await post('/api/oncall/softwarequote/quote', { agreementTerm, items: CART, customerPo: 'GLP-PO-2026-4471' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, status: 'QUOTE', agreementTerm, currency: 'USD', customerPo: 'GLP-PO-2026-4471' });
    expect(data.quoteNumber).toMatch(/^Q-\d{8}$/);
    expect(data.lines.map((l) => l.catalog)).toEqual(CART.map((c) => c.catalog));
    data.lines.forEach((l) => expect(l.discountPct).toBe(discountPct));
    expect(data.termNetUsd).toBeCloseTo(data.annualNetUsd * years, 1);
    expect(data.dueAtOrderUsd).toBe(data.annualNetUsd);
  });

  test('invalid terms, empty carts and unknown catalog numbers are client errors', async () => {
    const [term, empty, product] = await Promise.all([
      post('/api/oncall/softwarequote/quote', { agreementTerm: 'FOREVER', items: CART }),
      post('/api/oncall/softwarequote/quote', { agreementTerm: 'ANNUAL_1Y', items: [] }),
      post('/api/oncall/softwarequote/quote', { agreementTerm: 'ANNUAL_1Y', items: [{ catalog: 'NOPE-123', quantity: 1 }] }),
    ]);
    expect(term.status).toBe(400);
    expect(empty.status).toBe(400);
    expect(product.status).toBe(404);
  });
});
