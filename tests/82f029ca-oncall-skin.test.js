jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const fs = require('fs');
const path = require('path');
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

const PUBLIC = path.join(__dirname, '../app/public');
const TITLE = 'MyBoeingFleet - Fleet management, technical docs &amp; support';
const search = (query) => post('/api/oncall/fleetsearch/search', { query, searchType: 'boeingFleetSearch', lang: 'en_US' });

describe('82f029ca MyBoeingFleet Search on-call skin', () => {
  test('is a native, unlisted fleetsearch skin alerting to Slack only on a failed search', () => {
    const skin = getOncallSkin('82f029ca');
    expect(skin).toMatchObject({
      vertical: 'fleetsearch', oncallOnly: true, alertDestination: 'slack', paths: ['/myboeingfleet', '/mbf-search'],
      page: { file: '82f029ca.html', title: 'MyBoeingFleet - Fleet management, technical docs & support' },
    });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A BOEING SITE/);
    expect(skin.alertCard).toMatchObject({ title: '5xx rate \u2014 MyBoeingFleet Search: part number search', release: 'fleet-search@2026.11.2', team: 'fleet-search-oncall' });
    expect(skin.devinSession.promptAppendix).toContain('cc @Dana Whitfield (fleet-search-oncall)');
    const scenario = ALERT_SCENARIOS.fleetsearch;
    expect(scenario).toMatchObject({
      page: '82f029ca.html', apiPath: '/api/82f029ca/search', oncallApiPath: '/api/oncall/fleetsearch/search', alertOnStatus: [500], unlisted: true,
    });
    expect(scenario.triggerWhen).toBeUndefined();
    expect(scenario.metricQuery).toContain('service:checkout-api');
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|INTERCHANGE_CODES|ONE_WAY_POST_SB/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page with self-hosted assets', async () => {
    const paths = ['/oncall/c/82f029ca', '/82f029ca', '/myboeingfleet', '/mbf-search'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("var API = '/api/82f029ca/search'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/fleetsearch/search"');
    expect(html).toContain('const alertOnStatus = [500]');
    expect(html).toContain('NOT ACTUALLY A BOEING SITE');
    expect(html).toContain('placeholder="Search keyword, term or part #"');
    expect(html).toContain('MyBoeingFleet Login');
    expect(html).toContain('Search is unavailable right now. Please try again later.');
    expect(html).toContain('/verticals/82f029ca/mbf.css');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:|<iframe|onetrust|services\.boeing\.com\/bgsmedias/);
    const css = fs.readFileSync(path.join(PUBLIC, 'verticals/82f029ca/mbf.css'), 'utf8');
    const assets = [...new Set((html + css).match(/\/verticals\/82f029ca\/[^"')\s&]+/g))];
    expect(assets.length).toBeGreaterThan(5);
    expect(assets.filter((a) => !fs.existsSync(path.join(PUBLIC, a)))).toEqual([]);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/82f029ca/report`),
      fetch(`${baseUrl}/oncall/c/82f029ca/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('part number search for 414T4110-12 fails with a 500 TypeError', async () => {
    const res = await search('414T4110-12');
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      success: false, errorClass: 'TypeError', code: 'FLEET_SEARCH_FAILED', error: 'Search is unavailable right now. Please try again later.',
    });
  });

  test('keyword search returns MyBoeingFleet content results', async () => {
    const res = await search('airplane health');
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, query: 'airplane health', queryType: 'keyword' });
    expect(data.total).toBeGreaterThan(3);
    expect(data.results[0]).toMatchObject({
      type: 'content', title: 'Airplane Health Management (AHM)', url: 'https://services.boeing.com/maintenance/tech-ops/airplane-health-management-ahm',
    });
  });

  test.each([
    ['65C27561-6', 'Valve Assembly, Check \u2014 Hydraulic Return', ['65C27561-5']],
    ['161a1100-77', 'Beam Assembly, Main Landing Gear', ['161A1100-75', '161A1100-73']],
    ['BACB30LH3-4', 'Bolt, Hex Head, Close Tolerance', ['BACB30LH3-4A']],
  ])('part number search for %s returns the part with interchangeability', async (query, nomenclature, alternates) => {
    const res = await search(query);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, queryType: 'part' });
    expect(data.results[0]).toMatchObject({ type: 'part', partNumber: query.toUpperCase(), title: `${query.toUpperCase()} \u2014 ${nomenclature}` });
    expect(data.results[0].interchangeability.map((r) => r.partNumber)).toEqual(alternates);
  });

  test('an unknown part number returns an empty result set, not an error', async () => {
    const res = await search('123A4567-89');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, queryType: 'part', total: 0, results: [] });
  });

  test.each([[''], ['   '], ['x'.repeat(101)]])('invalid query %j returns 400', async (query) => {
    const res = await search(query);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'INVALID_QUERY' });
  });
});
