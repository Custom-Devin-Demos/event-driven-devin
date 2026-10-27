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

const TITLE = 'トヨタ | 該当するリコール等の内容と実施状況の検索';

describe('a6f389b5 recall search on-call skin', () => {
  test('is a native, unlisted recalllookup skin without report or incident surfaces', () => {
    const skin = getOncallSkin('a6f389b5');
    expect(skin).toMatchObject({ vertical: 'recalllookup', oncallOnly: true, page: { file: 'a6f389b5.html', title: TITLE } });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A TOYOTA SITE/);
    const scenario = ALERT_SCENARIOS.recalllookup;
    expect(scenario).toMatchObject({
      apiPath: '/api/a6f389b5/recall',
      oncallApiPath: '/api/oncall/recalllookup/search',
      triggerWhen: { frameDiv: 'TKX230', frameNo: '0104518' },
      unlisted: true,
    });
    expect(JSON.stringify(scenario) + JSON.stringify(skin)).not.toMatch(/\.js|TypeError|CAMPAIGN_INDEX|typeDesignation|6LA-/);
  });

  test('skin URL and direct slug serve the same shimmed page', async () => {
    const [skinned, direct] = await Promise.all([fetch(`${baseUrl}/oncall/c/a6f389b5`), fetch(`${baseUrl}/a6f389b5`)]);
    expect(skinned.status).toBe(200);
    const html = await skinned.text();
    expect(await direct.text()).toEqual(html);
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/a6f389b5/recall'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/recalllookup/search"');
    expect(html).toContain('const triggerWhen = {"frameDiv":"TKX230","frameNo":"0104518"}');
    expect(html).toContain('NOT ACTUALLY A TOYOTA SITE');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('report and incident surfaces 404', async () => {
    const [report, incident] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/a6f389b5/report`),
      fetch(`${baseUrl}/oncall/c/a6f389b5/incident`),
    ]);
    expect(report.status).toBe(404);
    expect(incident.status).toBe(404);
  });

  test('the prefilled chassis number fails with a 500, older vehicles return their results', async () => {
    const broken = await post('/api/oncall/recalllookup/search', { frameDiv: 'TKX230', frameNo: '0104518' });
    expect(broken.status).toBe(500);
    expect(await broken.json()).toMatchObject({ success: false, errorClass: 'TypeError', code: 'RECALL_SEARCH_FAILED' });
    const ok = await post('/api/oncall/recalllookup/search', { frameDiv: 'tkx210', frameNo: '3021877' });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ success: true, chassisNumber: 'TKX210-3021877', model: 'TKX210', campaigns: [] });
    expect((await post('/api/oncall/recalllookup/search', { frameDiv: 'ABC-1', frameNo: '12' })).status).toBe(400);
    expect((await post('/api/oncall/recalllookup/search', { frameDiv: 'ABC123', frameNo: '1234567' })).status).toBe(404);
  });
});
