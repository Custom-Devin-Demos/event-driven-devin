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

const TITLE = 'Design Your Rivian R2 | Configurator | Rivian';

describe('492753fe Rivian R2 reservation on-call skin', () => {
  test('is a native, unlisted evreservation skin without report or incident surfaces', () => {
    const skin = getOncallSkin('492753fe');
    expect(skin).toMatchObject({ vertical: 'evreservation', oncallOnly: true, alertDestination: 'slack', page: { file: '492753fe.html', title: TITLE } });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A RIVIAN SITE/);
    const scenario = ALERT_SCENARIOS.evreservation;
    expect(scenario).toMatchObject({
      apiPath: '/api/492753fe/reservations', oncallApiPath: '/api/oncall/evreservation/reservations', triggerWhen: { trim: 'performance' }, unlisted: true,
    });
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|DEPOSIT_SCHEDULES|R2-PERF-LE|amountCents/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/492753fe', '/492753fe', '/rivian', '/rivian-r2'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/492753fe/reservations'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/evreservation/reservations"');
    expect(html).toContain('const triggerWhen = {"trim":"performance"}');
    expect(html).toContain('NOT ACTUALLY A RIVIAN SITE');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/492753fe/report`),
      fetch(`${baseUrl}/oncall/c/492753fe/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('Confirm reservation fails with a 500 TypeError for R2 Performance', async () => {
    const res = await post('/api/oncall/evreservation/reservations', { trim: 'performance', paint: 'esv' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, errorClass: 'TypeError', code: 'RESERVATION_FAILED' });
  });

  test.each(['premium', 'standard'])('Confirm reservation succeeds for R2 %s', async (trim) => {
    const res = await post('/api/oncall/evreservation/reservations', { trim });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, deposit: { amountCents: 10000, currency: 'USD', refundable: true } });
  });

  test('unknown trims return 400', async () => {
    const res = await post('/api/oncall/evreservation/reservations', { trim: 'r3x' });
    expect(res.status).toBe(400);
  });
});
