jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const express = require('express');
const http = require('http');
const fs = require('fs');
const path = require('path');

const oncallRoutes = require('../app/routes/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

const SLUG = '2e790636';
const TITLE = 'Make a payment | Kestrel Bank Online Banking';
const PAGE = fs.readFileSync(path.join(__dirname, '..', 'app', 'public', 'verticals', `${SLUG}.html`), 'utf8');

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
  server.closeAllConnections();
  server.close(done);
});

describe('2e790636 Kestrel Bank Make a payment on-call skin', () => {
  test('is a native, unlisted banking skin that hangs then fails and alerts to Slack', () => {
    const skin = getOncallSkin(SLUG);
    expect(skin).toMatchObject({
      company: 'Kestrel Bank', vertical: 'banking', oncallOnly: true, failAfterHang: true,
      alertDestination: 'slack', page: { file: `${SLUG}.html`, title: TITLE },
      devinSession: { onCallIsTriggerer: true },
    });
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A KESTREL BANK SITE/);
    expect(skin.alertCard.title).toBe('5xx rate \u2014 Kestrel Bank Online Banking: Make a payment');
  });

  test('serves the native page with the disclaimer and the configured title', async () => {
    const res = await fetch(`${baseUrl}/oncall/c/${SLUG}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain('NOT ACTUALLY A KESTREL BANK SITE');
    expect(html).not.toContain('All Demos');
  });

  test('carries no real-bank branding or third-party assets', () => {
    const text = `${PAGE}\n${JSON.stringify(getOncallSkin(SLUG))}`;
    expect(text).not.toMatch(/natwest|westminster|scene7|#5E10B1/i);
    expect(PAGE).not.toMatch(/<img[^>]+src="https?:/i);
  });
});
