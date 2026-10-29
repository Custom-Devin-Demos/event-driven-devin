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
const { COMPANIES, FILTER_DEADLINE_MS } = require('../app/services/oncall-verticals/bxportfolio');

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

const TITLE = 'Our Portfolio - Blackstone';
const API = '/api/oncall/bxportfolio/companies';

describe('a3c9e7b1 Blackstone Our Portfolio on-call skin', () => {
  test('is a native, unlisted bxportfolio skin with en-plain alert copy and no report or incident surfaces', () => {
    const skin = getOncallSkin('a3c9e7b1');
    expect(skin).toMatchObject({ vertical: 'bxportfolio', oncallOnly: true, alertDestination: 'slack', locale: 'en-plain', page: { file: 'a3c9e7b1.html', title: TITLE } });
    expect(skin.paths).toEqual(['/blackstone', '/bx']);
    expect(skin.devinSession).toMatchObject({ auto: true, onCallIsTriggerer: true });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A BLACKSTONE SITE/);
    const scenario = ALERT_SCENARIOS.bxportfolio;
    expect(scenario).toMatchObject({ apiPath: '/api/a3c9e7b1/portfolio', oncallApiPath: API, alertOnStatus: [500], retryWindow: true, unlisted: true });
    expect(scenario.triggerWhen).toBeUndefined();
    const copy = JSON.stringify(scenario) + JSON.stringify(skin);
    expect(copy).not.toMatch(/\u2014/);
    expect(copy).not.toMatch(/\.js|TypeError|resolveProfiles|fetchCompanyProfile|PROFILE_LOOKUP|CACHED_INDEX/i);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/a3c9e7b1', '/a3c9e7b1', '/blackstone', '/bx'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/a3c9e7b1/portfolio'");
    expect(html).toContain(`const oncallApiPath = ${JSON.stringify(API)}`);
    expect(html).toContain('const triggerWhen = null');
    expect(html).toContain('const alertOnStatus = [500]');
    expect(html).toContain('const retryWindowEnabled = true');
    expect(html).toContain('Portfolio unavailable');
    expect(html).toContain('id="retryLoad"');
    expect(html).toContain('NOT ACTUALLY A BLACKSTONE SITE');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/a3c9e7b1/report`),
      fetch(`${baseUrl}/oncall/c/a3c9e7b1/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('the unfiltered page load returns the whole portfolio quickly', async () => {
    const started = Date.now();
    const res = await post(API, {});
    expect(Date.now() - started).toBeLessThan(1000);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ success: true, total: COMPANIES.length, filters: { business: null, sector: null, region: null } });
    expect(body.companies.map((c) => c.name).sort()).toEqual(COMPANIES.map((c) => c.name).sort());
  });

  test('"all" and empty values are treated as no filter', async () => {
    const res = await post(API, { business: 'all', sector: '', region: 'All' });
    expect(res.status).toBe(200);
    expect((await res.json()).total).toBe(COMPANIES.length);
  });

  test.each([
    ['business', { business: 'private-equity' }],
    ['sector', { sector: 'technology' }],
    ['region', { region: 'europe' }],
  ])('selecting a %s hangs to the deadline and fails with HTTP 500', async (_facet, filters) => {
    const started = Date.now();
    const res = await post(API, filters);
    const elapsed = Date.now() - started;
    expect(res.status).toBe(500);
    expect(elapsed).toBeGreaterThanOrEqual(FILTER_DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(FILTER_DEADLINE_MS + 1500);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, code: 'PORTFOLIO_FILTER_TIMEOUT' });
    expect(JSON.stringify(body)).not.toMatch(/profile|content.store|deadline|\.js/i);
  }, 15000);

  test('unknown filter values return 400 immediately', async () => {
    const started = Date.now();
    const bad = await Promise.all([
      post(API, { business: 'hedge-funds' }),
      post(API, { sector: 'energy' }),
      post(API, { region: 'apac' }),
      post(API, { business: 'constructor' }),
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
    for (const res of bad) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, code: 'INVALID_FILTER' });
    }
  });
});
