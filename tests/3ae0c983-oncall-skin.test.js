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

const TITLE = '1/4 in. Drive Ratcheting Head Micrometer Torque Wrench With Quick Release Head Design | PROTO';

describe('3ae0c983 Where to Buy on-call skin', () => {
  test('is a native, unlisted wheretobuy skin without report or incident surfaces', () => {
    const skin = getOncallSkin('3ae0c983');
    expect(skin).toMatchObject({ vertical: 'wheretobuy', oncallOnly: true, page: { file: '3ae0c983.html', title: TITLE } });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A PROTO INDUSTRIAL TOOLS SITE/);
    const scenario = ALERT_SCENARIOS.wheretobuy;
    expect(scenario).toMatchObject({
      apiPath: '/api/3ae0c983/where-to-buy', oncallApiPath: '/api/oncall/wheretobuy/retailers', triggerWhen: { sku: 'J6060B' }, unlisted: true,
    });
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|LINE_CHANNELS|CHANNEL_RETAILERS|TQW-QRH/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/3ae0c983', '/3ae0c983', '/proto', '/protoindustrial'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/3ae0c983/where-to-buy'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/wheretobuy/retailers"');
    expect(html).toContain('const triggerWhen = {"sku":"J6060B"}');
    expect(html).toContain('NOT ACTUALLY A PROTO INDUSTRIAL TOOLS SITE');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/3ae0c983/report`),
      fetch(`${baseUrl}/oncall/c/3ae0c983/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('Where to Buy fails with a 500 TypeError for J6060B only', async () => {
    const res = await post('/api/oncall/wheretobuy/retailers', { sku: 'J6060B' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, errorClass: 'TypeError', code: 'WHERE_TO_BUY_FAILED' });
  });

  test.each(['J6062C', 'J6062CXCERT', 'J6064C', 'J6072CXCERT', 'J6202A'])('Where to Buy lists distributors for %s', async (sku) => {
    const res = await post('/api/oncall/wheretobuy/retailers', { sku });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, sku });
    expect(data.retailers.length).toBeGreaterThan(0);
  });

  test('unknown SKUs return 404', async () => {
    const res = await post('/api/oncall/wheretobuy/retailers', { sku: 'NOPE123' });
    expect(res.status).toBe(404);
  });
});
