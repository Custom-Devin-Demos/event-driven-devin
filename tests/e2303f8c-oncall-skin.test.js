jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');

const oncallRoutes = require('../app/routes/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  server = http.createServer(app);
  server.listen(0, () => {
    baseUrl = `http://127.0.0.1:${server.address().port}`;
    done();
  });
});

afterAll((done) => {
  server.close(done);
});

describe('e2303f8c MiniMed CareLink on-call skin', () => {
  test('is a native banking skin that always alerts to Teams', () => {
    expect(getOncallSkin('e2303f8c')).toMatchObject({
      company: 'MiniMed',
      vertical: 'banking',
      oncallOnly: true,
      teamsAlerts: true,
      alertDestination: 'teams',
      page: { file: 'e2303f8c.html', title: 'Upload & reports | MiniMed CareLink' },
    });
  });

  test('skin URL and direct slug serve the same shimmed page', async () => {
    const [skinned, direct] = await Promise.all([
      fetch(`${baseUrl}/oncall/c/e2303f8c`),
      fetch(`${baseUrl}/e2303f8c`),
    ]);
    expect(skinned.status).toBe(200);
    const html = await skinned.text();
    expect(await direct.text()).toEqual(html);
    expect(html).toContain('<title>Upload &amp; reports | MiniMed CareLink</title>');
    expect(html).toContain("fetch('/api/banking/transfer'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/banking/transfer"');
    expect(html).toContain('var skinAlertDestination = "teams"');
    expect(html).toContain('NOT ACTUALLY A MINIMED SITE');
    expect(html).toContain('const triggerWhen = {"accountTier":"standard"}');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('stock banking skins keep the scenario trigger (alert on every submit)', async () => {
    const html = await (await fetch(`${baseUrl}/oncall/c/8df370c5`)).text();
    expect(html).toContain('const triggerWhen = null');
  });

  test('alert card copy stays metric-shaped and free of the company name', () => {
    const card = JSON.stringify(getOncallSkin('e2303f8c').alertCard);
    expect(card).not.toMatch(/MiniMed|Medtronic|TypeError|\.js/);
  });
});
