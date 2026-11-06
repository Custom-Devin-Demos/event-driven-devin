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
const TITLE = 'Airplane Emergent Services | Boeing Global Services';
const REQUEST = {
  firstname: 'Koffi', lastname: 'Kouassi', email: 'aog.control@abidjan-aerotech.example', company: 'Abidjan Aero Technique',
  country: "C\u00f4te d'Ivoire", station: 'ABJ', aircraftModel: '737-800', tailNumber: 'tu-tsz', partNumber: '65c27561-6', ataChapter: '29',
  otherInfo: 'Hydraulic system B return check valve leaking.', optin: 'no',
};
const submit = (overrides) => post('/api/oncall/aogrequest/requests', { ...REQUEST, ...overrides });

describe('82f029ca Boeing Global Services AOG request on-call skin', () => {
  test('is a native, unlisted aogrequest skin alerting to Slack only on a failed submit', () => {
    const skin = getOncallSkin('82f029ca');
    expect(skin).toMatchObject({
      company: 'Boeing Global Services', vertical: 'aogrequest', oncallOnly: true, alertDestination: 'slack', paths: ['/boeing-aog', '/aog-request'],
      page: { file: '82f029ca.html', title: TITLE },
    });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A BOEING SITE/);
    expect(skin.alertCard).toMatchObject({ title: '5xx rate \u2014 Boeing AOG request: Submit', release: 'aog-intake@2026.11.3', team: 'aog-intake-oncall' });
    expect(skin.devinSession.promptAppendix).toContain('cc @Dana Whitfield (aog-intake-oncall)');
    const scenario = ALERT_SCENARIOS.aogrequest;
    expect(scenario).toMatchObject({
      page: '82f029ca.html', apiPath: '/api/82f029ca/aog-requests', oncallApiPath: '/api/oncall/aogrequest/requests', alertOnStatus: [500], unlisted: true,
    });
    expect(ALERT_SCENARIOS.fleetsearch).toBeUndefined();
    expect(scenario.triggerWhen).toBeUndefined();
    expect(scenario.metricQuery).toContain('service:checkout-api');
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|COUNTRY_REGIONS|REGION_COUNTRIES|geo-ref.*\u00c3/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page with self-hosted assets', async () => {
    const paths = ['/oncall/c/82f029ca', '/82f029ca', '/boeing-aog', '/aog-request'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("var API = '/api/82f029ca/aog-requests'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/aogrequest/requests"');
    expect(html).toContain('const alertOnStatus = [500]');
    expect(html).toContain('NOT ACTUALLY A BOEING SITE');
    expect(html).toContain('Emergent Services');
    expect(html).toContain('Aircraft on ground? Request AOG support');
    expect(html).toContain('<option selected="" value="C\u00f4te d\'Ivoire">');
    expect(html).toContain('value="TU-TSZ"');
    expect(html).toContain('/verticals/82f029ca/aog.css');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:|<iframe|onetrust|services\.boeing\.com\/bgsmedias|\u00c3/);
    const css = fs.readFileSync(path.join(PUBLIC, 'verticals/82f029ca/aog.css'), 'utf8');
    const assets = [...new Set((html + css).match(/\/verticals\/82f029ca\/[^"')\s&]+/g))];
    expect(assets.length).toBeGreaterThan(10);
    expect(assets.filter((a) => !fs.existsSync(path.join(PUBLIC, a)))).toEqual([]);
  });

  test('every country on the form is offered by the page', async () => {
    const { COUNTRIES } = require('../app/services/oncall-verticals/aogrequest');
    const html = await (await fetch(`${baseUrl}/oncall/c/82f029ca`)).text();
    const select = html.slice(html.indexOf('id="country"'), html.indexOf('</select>', html.indexOf('id="country"')));
    const options = [...select.matchAll(/<option[^>]*value="([^"]+)"/g)].map((m) => m[1].replace(/&amp;/g, '&'));
    expect(options).toEqual(COUNTRIES);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/82f029ca/report`),
      fetch(`${baseUrl}/oncall/c/82f029ca/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test("an AOG request from C\u00f4te d'Ivoire fails with a 500 TypeError", async () => {
    const res = await submit();
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({
      success: false, errorClass: 'TypeError', code: 'AOG_REQUEST_FAILED', error: "We couldn't submit your AOG request. Please try again later.",
    });
  });

  test.each([
    ['United States', 'AMER', 'Boeing AOG Desk \u2014 Americas (Seattle)'],
    ['Kenya', 'EMEA', 'Boeing AOG Desk \u2014 Europe, Middle East & Africa (London)'],
    ['Senegal', 'EMEA', 'Boeing AOG Desk \u2014 Europe, Middle East & Africa (London)'],
    ['Singapore', 'APAC', 'Boeing AOG Desk \u2014 Asia Pacific (Singapore)'],
  ])('an AOG request from %s is queued to the %s desk', async (country, region, name) => {
    const res = await submit({ country });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({
      success: true, desk: { region, name, firstResponseMinutes: 30 },
      aircraft: { model: '737-800', tailNumber: 'TU-TSZ', station: 'ABJ' }, partNumber: '65C27561-6', ataChapter: '29',
    });
    expect(data.requestNumber).toMatch(/^AOG-\d{6}-\d{4}$/);
  });

  test.each([
    [{ tailNumber: '' }, 'tailNumber'],
    [{ email: 'not-an-email' }, 'email'],
    [{ country: 'Atlantis' }, 'country'],
    [{ aircraftModel: 'A320' }, 'aircraftModel'],
    [{ tailNumber: 'TU TSZ 99999' }, 'tailNumber'],
  ])('invalid request %j returns 400 for %s', async (overrides, field) => {
    const res = await submit(overrides);
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ success: false, code: 'INVALID_REQUEST', field });
  });
});
