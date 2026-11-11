jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

jest.mock('../app/services/slack', () => ({
  ownerRotation: jest.requireActual('../app/services/slack').ownerRotation,
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 's', url: 'https://app.devin.ai/sessions/s' }),
}));

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const express = require('express');
const http = require('http');
const path = require('path');
const { stopGateway } = require('../app/services/oncall-verticals/industrials-edge');

const oncallRoutes = require('../app/routes/oncall');
const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { postOncallAlert } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

let server;
let baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  app.use(express.static(path.join(__dirname, '..', 'app', 'public'), { index: false }));
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

const SLUG = '4f59cb55';
const TITLE = 'Checkout | MECCA';

describe('4f59cb55 gift-with-purchase checkout on-call skin', () => {
  test('is a Slack-pinned native banking skin with /mecca aliases and a release/team alert card', () => {
    const skin = getOncallSkin(SLUG);
    expect(skin).toMatchObject({
      company: 'MECCA',
      vertical: 'banking',
      oncallOnly: true,
      alertDestination: 'slack',
      paths: ['/mecca', '/mecca-oncall'],
      page: { file: `${SLUG}.html`, title: TITLE },
    });
    expect(Object.keys(skin.theme).sort()).toEqual(['--accent', '--chrome-bg', '--chrome-text', '--ink', '--surface']);
    expect(skin.alertCard).toMatchObject({ release: 'web-checkout@2026.11.4', team: 'digital-checkout' });
    expect(skin.alertCard.metricQuery).toContain('resource:POST /api/oncall/banking/transfer');
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A MECCA SITE/);
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(Object.values(skin.alertCard).join(' ')).not.toMatch(/\.js|compliance|screening|COMPLIANCE_CONFIG|Apex/i);
  });

  test('posts a checkout-worded card to the on-call alerts channel', async () => {
    const skin = getOncallSkin(SLUG);
    await postOncallAlert(skin.vertical, { skin, runRef: 'run-test' });
    const [, channel, text] = postMessage.mock.calls[postMessage.mock.calls.length - 1];
    expect(channel).toBe('C0TEST');
    expect(text).toContain('Checkout: place order');
    expect(text).toContain('web-checkout-api (MECCA)');
    expect(text).toContain('web-checkout@2026.11.4');
    expect(text).toContain('/oncall/c/4f59cb55');
    expect(text).not.toMatch(/Apex Bank|apex-bank/);
  });

  test('skin URL and both aliases serve the same shimmed checkout page', async () => {
    const paths = [`/oncall/c/${SLUG}`, `/${SLUG}`, '/mecca', '/mecca-oncall'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/banking/transfer'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/banking/transfer"');
    expect(html).toContain('NOT ACTUALLY A MECCA SITE');
    ['transferForm', 'fromAccount', 'toAccount', 'amount', 'accountTier', 'submitBtn', 'result']
      .forEach((id) => expect(html).toContain(`id="${id}"`));
    expect(html).toMatch(/<option value="standard" selected>/);
    expect(html).toContain('/session-cap-banner.js');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('unrequested report and incident surfaces stay 404', async () => {
    const statuses = await Promise.all([`/oncall/c/${SLUG}/report`, `/oncall/c/${SLUG}/incident`, '/oncall/c/00000000']
      .map(async (p) => (await fetch(`${baseUrl}${p}`)).status));
    expect(statuses).toEqual([404, 404, 404]);
  });
});
