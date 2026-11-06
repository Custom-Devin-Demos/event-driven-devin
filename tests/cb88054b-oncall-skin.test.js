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

const TITLE = 'Line 3 \u00b7 Line Control | LineWorks MES';

describe('cb88054b LineWorks MES Line Control on-call skin', () => {
  test('is a native, unlisted linecontrol skin without report or incident surfaces', () => {
    const skin = getOncallSkin('cb88054b');
    expect(skin).toMatchObject({ vertical: 'linecontrol', oncallOnly: true, alertDestination: 'slack', page: { file: 'cb88054b.html', title: TITLE } });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT A REAL MANUFACTURER/);
    const scenario = ALERT_SCENARIOS.linecontrol;
    expect(scenario).toMatchObject({
      apiPath: '/api/cb88054b/changeover', oncallApiPath: '/api/oncall/linecontrol/changeover', triggerWhen: { model: 'HX-450-G2' }, unlisted: true,
    });
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|TORQUE_PROGRAMS|TQ-M12-HD-G2|ECN-24117/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/cb88054b', '/cb88054b', '/line-control', '/mes-line', '/manufacturing-line'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/cb88054b/changeover'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/linecontrol/changeover"');
    expect(html).toContain('const triggerWhen = {"model":"HX-450-G2"}');
    expect(html).toContain('NOT A REAL MANUFACTURER');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/cb88054b/report`),
      fetch(`${baseUrl}/oncall/c/cb88054b/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('Changeover & start fails with a 500 TypeError for HX-450-G2 only', async () => {
    const res = await post('/api/oncall/linecontrol/changeover', { line: 'L3', model: 'HX-450-G2', workOrder: 'WO-24-11874' });
    expect(res.status).toBe(500);
    const data = await res.json();
    expect(data).toMatchObject({ success: false, errorClass: 'TypeError', code: 'CHANGEOVER_FAILED' });
    expect(JSON.stringify(data)).not.toMatch(/targetNm|TORQUE_PROGRAMS|TQ-M12/);
  });

  test.each(['HX-300', 'HX-350', 'HX-450'])('Changeover & start releases Line 3 for %s', async (model) => {
    const res = await post('/api/oncall/linecontrol/changeover', { line: 'L3', model });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, line: 'L3', model, status: 'RUNNING' });
    expect(data.stations.map((s) => s.station)).toEqual(['ST10', 'ST20', 'ST30', 'ST40', 'ST50', 'ST60', 'ST70']);
    data.stations.forEach((s) => expect(s.status).toBe('DOWNLOADED'));
  });

  test('unknown models and lines return 404', async () => {
    const [model, line] = await Promise.all([
      post('/api/oncall/linecontrol/changeover', { line: 'L3', model: 'NOPE' }),
      post('/api/oncall/linecontrol/changeover', { line: 'L9', model: 'HX-300' }),
    ]);
    expect(model.status).toBe(404);
    expect(line.status).toBe(404);
  });
});
