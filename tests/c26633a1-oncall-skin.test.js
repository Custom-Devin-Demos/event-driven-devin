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
const { postMessage } = require('../app/services/slack');
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

const TITLE = 'Checkout | Chewy.com';

describe('c26633a1 checkout on-call skin', () => {
  test('is a native, Slack-pinned marketplace skin without an app-created Devin session', () => {
    const skin = getOncallSkin('c26633a1');
    expect(skin).toMatchObject({
      vertical: 'marketplace',
      oncallOnly: true,
      alertDestination: 'slack',
      page: { file: 'c26633a1.html', title: TITLE },
    });
    expect(skin.devinSession).toBeUndefined();
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A CHEWY SITE/);
  });

  test('posts a checkout-worded card to the on-call alerts channel with the real endpoint', async () => {
    const skin = getOncallSkin('c26633a1');
    await postOncallAlert(skin.vertical, { skin, runRef: 'run-test' });
    const [, channel, text] = postMessage.mock.calls[postMessage.mock.calls.length - 1];
    expect(channel).toBe('C0TEST');
    expect(text).toContain('*[Triggered] p95 latency spike \u2014 Checkout Place Order (504)*');
    expect(text).toContain('*Service:* checkout-api (Chewy)');
    expect(text).toContain('*Endpoint:* POST /api/oncall/marketplace/cart');
    expect(text).toContain('/oncall/c/c26633a1');
    expect(text).not.toMatch(/Marktplatz|Kaufland|add-to-cart/i);
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(Object.values(skin.alertCard).join(' ')).not.toMatch(/\.js|RESERVATION_DEADLINE|withDeadline|fulfillment node/i);
  });

  test('skin URL, direct slug and alias serve the same shimmed checkout page', async () => {
    const paths = ['/oncall/c/c26633a1', '/c26633a1', '/chewy-oncall'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/marketplace/cart'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/marketplace/cart"');
    expect(html).toContain('id="placeOrderBtn"');
    expect(html).toContain('Jordan Ellis');
    expect(html).toContain('1847 MAPLE GROVE LN');
    expect(html).toContain('NOT ACTUALLY A CHEWY SITE');
    expect(html).not.toMatch(/<base |<script[^>]+src="https?:/);
  });

  test('page assets are served locally', async () => {
    const assets = ['logo', 'bag', 'thumb', 'autoship', 'shield'];
    const statuses = await Promise.all(assets.map(async (a) => (await fetch(`${baseUrl}/verticals/c26633a1/${a}.png`)).status));
    expect(statuses).toEqual(assets.map(() => 200));
  });
});
