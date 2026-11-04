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

const TITLE = 'Release Gate | Bench Results | BorgWarner';

describe('7b3e91c4 BorgWarner Release Gate on-call skin', () => {
  test('is a native, unlisted releasegate skin without report or incident surfaces', () => {
    const skin = getOncallSkin('7b3e91c4');
    expect(skin).toMatchObject({ vertical: 'releasegate', oncallOnly: true, page: { file: '7b3e91c4.html', title: TITLE } });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A BORGWARNER SITE/);
    const scenario = ALERT_SCENARIOS.releasegate;
    expect(scenario).toMatchObject({
      apiPath: '/api/7b3e91c4/release-gate', oncallApiPath: '/api/oncall/releasegate/evaluate', triggerWhen: { program: 'INV800' }, unlisted: true,
    });
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|GATE_POLICIES|ASIL-D-800V/);
  });

  test('skin URL, direct slug and aliases serve the same shimmed page', async () => {
    const paths = ['/oncall/c/7b3e91c4', '/7b3e91c4', '/borgwarner', '/bw-release-gate'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/7b3e91c4/release-gate'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/releasegate/evaluate"');
    expect(html).toContain('const triggerWhen = {"program":"INV800"}');
    expect(html).toContain('NOT ACTUALLY A BORGWARNER SITE');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/7b3e91c4/report`),
      fetch(`${baseUrl}/oncall/c/7b3e91c4/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('Run release gate fails with a 500 TypeError for INV800 only', async () => {
    const res = await post('/api/oncall/releasegate/evaluate', { program: 'INV800' });
    expect(res.status).toBe(500);
    expect(await res.json()).toMatchObject({ success: false, errorClass: 'TypeError', code: 'RELEASE_GATE_FAILED' });
  });

  test.each(['IDM220', 'DCDC48', 'OBC11'])('Run release gate returns a verdict for %s', async (program) => {
    const res = await post('/api/oncall/releasegate/evaluate', { program });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toMatchObject({ success: true, program });
    expect(['GREEN', 'AMBER', 'RED']).toContain(data.status);
  });

  test('unknown programs return 404', async () => {
    const res = await post('/api/oncall/releasegate/evaluate', { program: 'NOPE' });
    expect(res.status).toBe(404);
  });
});
