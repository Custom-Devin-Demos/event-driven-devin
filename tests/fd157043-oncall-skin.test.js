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
const { COMPANIES, GRID_DEADLINE_MS } = require('../app/services/oncall-verticals/portfoliofilter');

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

const TITLE = 'Our Portfolio - Hellman & Friedman';
const API = '/api/oncall/portfoliofilter/companies';

describe('fd157043 Hellman & Friedman Our Portfolio on-call skin', () => {
  test('is a native, unlisted portfoliofilter skin without report or incident surfaces', () => {
    const skin = getOncallSkin('fd157043');
    expect(skin).toMatchObject({ vertical: 'portfoliofilter', oncallOnly: true, alertDestination: 'slack', page: { file: 'fd157043.html', title: TITLE } });
    expect(skin.devinSession).toMatchObject({ auto: true, onCallIsTriggerer: true });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A HELLMAN & FRIEDMAN SITE/);
    const scenario = ALERT_SCENARIOS.portfoliofilter;
    expect(scenario).toMatchObject({ apiPath: '/api/fd157043/portfolio', oncallApiPath: API, retryWindow: true, unlisted: true });
    expect(scenario.triggerWhen).toBeUndefined();
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|resolveProfiles|fetchCompanyProfile|PROFILE_LOOKUP|content-store profile lookup per company/i);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/fd157043', '/fd157043', '/hf', '/hellman-friedman', '/hf-portfolio'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/fd157043/portfolio'");
    expect(html).toContain(`const oncallApiPath = ${JSON.stringify(API)}`);
    expect(html).toContain('const triggerWhen = null');
    expect(html).toContain('const retryWindowEnabled = true');
    expect(html).toContain('Our portfolio is temporarily unavailable.');
    expect(html).toContain('NOT ACTUALLY A HELLMAN & FRIEDMAN SITE');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/fd157043/report`),
      fetch(`${baseUrl}/oncall/c/fd157043/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('the unfiltered page-load query hangs to the deadline and fails with 504', async () => {
    const started = Date.now();
    const res = await post(API, {});
    const elapsed = Date.now() - started;
    expect(res.status).toBe(504);
    expect(elapsed).toBeGreaterThanOrEqual(GRID_DEADLINE_MS - 50);
    expect(elapsed).toBeLessThan(GRID_DEADLINE_MS + 1500);
    const body = await res.json();
    expect(body).toMatchObject({ success: false, code: 'PORTFOLIO_TIMEOUT' });
    expect(JSON.stringify(body)).not.toMatch(/profile|content.store|deadline|\.js/i);
  }, 15000);

  test('a narrower filtered view still loads, slowly, with correct companies', async () => {
    const started = Date.now();
    const res = await post(API, { status: 'past', geography: 'europe' });
    const elapsed = Date.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeGreaterThan(500);
    const body = await res.json();
    const expected = COMPANIES.filter((c) => c.status === 'past' && c.geography === 'europe');
    expect(body).toMatchObject({ success: true, total: expected.length, filters: { sector: null, status: 'Past', geography: 'Europe' } });
    expect(body.sections).toHaveLength(1);
    expect(body.sections[0].companies.map((c) => c.name).sort()).toEqual(expected.map((c) => c.name).sort());
    body.sections[0].companies.forEach((c) => expect(c).toMatchObject({ status: 'Past', geography: 'Europe', mark: expect.any(String) }));
  }, 15000);

  test('"all" and empty values are treated as no filter and hit the deadline like the page load', async () => {
    const res = await post(API, { sector: 'all', status: '', geography: 'All' });
    expect(res.status).toBe(504);
  }, 15000);

  test('unknown filter values return 400 immediately without an alert', async () => {
    const started = Date.now();
    const bad = await Promise.all([
      post(API, { sector: 'energy' }),
      post(API, { status: 'realized' }),
      post(API, { geography: 'apac' }),
      post(API, { status: 'constructor' }),
    ]);
    expect(Date.now() - started).toBeLessThan(1000);
    for (const res of bad) {
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ success: false, code: 'INVALID_FILTER' });
    }
  });
});
