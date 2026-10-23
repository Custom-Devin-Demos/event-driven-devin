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

const TITLE = 'Wispr Flow — Dictation';

describe('7e48b807 Wispr Flow Slack-routed dictation on-call skin', () => {
  test('is a native voice skin pinned to Slack alerts, separate from 2acc11fd', () => {
    const skin = getOncallSkin('7e48b807');
    expect(skin).toMatchObject({
      company: 'Wispr Flow',
      vertical: 'voice',
      oncallOnly: true,
      alertDestination: 'slack',
      paths: ['/wispr-oncall'],
      page: { file: '7e48b807.html', title: TITLE },
    });
    expect(skin.alertCard).toMatchObject({ release: 'wispr-flow@2.4.1', team: 'flow-dictation-oncall' });
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A WISPR FLOW SITE/);
    expect(skin.devinSession).toBeUndefined();

    const original = getOncallSkin('2acc11fd');
    expect(original.page.file).toBe('2acc11fd.html');
    expect(original.alertDestination).toBeUndefined();
  });

  test('skin URL, direct slug and alias serve the same shimmed dictation page', async () => {
    const paths = ['/oncall/c/7e48b807', '/7e48b807', '/wispr-oncall'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain('<title>Wispr Flow &mdash; Dictation</title>');
    expect(html).toContain("fetch('/api/voice/transcribe'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/voice/transcribe"');
    expect(html).toContain('NOT ACTUALLY A WISPR FLOW SITE');
    ['transcribeForm', 'micBtn', 'utterance', 'workspace', 'dictionary', 'submitBtn', 'result']
      .forEach((id) => expect(html).toContain(`id="${id}"`));
  });
});
