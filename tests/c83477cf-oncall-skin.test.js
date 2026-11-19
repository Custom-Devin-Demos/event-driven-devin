/* global afterAll, afterEach, beforeAll, beforeEach, describe, expect, fetch, jest, test */

jest.mock('axios');
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

const express = require('express');
const http = require('http');
const axios = require('axios');
const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const oncallRoutes = require('../app/routes/oncall');
const { resetSkinAlertMemory } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');
const { parseArgs, triggerSkin } = require('../scripts/oncall-deploy-trigger');

const SLUG = 'c83477cf';
const TITLE = 'EOD Snapshot Publish | Fenics MarketData';
const TEAMS_URL = 'https://default8019.65.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=x';
const ENV_KEYS = ['SLACK_ONCALL_BOT_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_ONCALL_ALERTS_CHANNEL_ID', 'ONCALL_TEAMS_WEBHOOK_URL', 'ONCALL_TEAMS_ALL_ALERTS', 'ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI'];
const savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

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

describe('c83477cf Fenics MarketData EOD snapshot On-Call skin', () => {
  beforeEach(() => {
    resetSkinAlertMemory();
    jest.clearAllMocks();
    ENV_KEYS.forEach((k) => delete process.env[k]);
    axios.post.mockResolvedValue({ status: 202 });
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
  });

  test('is a Teams-routed native banking skin that fails after the hang', () => {
    expect(getOncallSkin(SLUG)).toMatchObject({
      company: 'Fenics Market Data',
      vertical: 'banking',
      oncallOnly: true,
      failAfterHang: true,
      teamsAlerts: true,
      teamsWebhookEnv: 'ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI',
      alertDestination: 'teams',
      page: { file: 'c83477cf.html', title: TITLE },
      deployTrigger: { path: '/api/oncall/banking/transfer' },
    });
  });

  test('serves the native Fenics page with the stock banking form contract and the on-call shim', async () => {
    const res = await fetch(`${baseUrl}/oncall/c/${SLUG}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/banking/transfer'");
    ['transferForm', 'fromAccount', 'toAccount', 'amount', 'accountTier', 'submitBtn', 'result'].forEach((id) => {
      expect(html).toContain(`id="${id}"`);
    });
    expect(html).toContain('Publish EOD snapshot');
    expect(html).toContain('/api/oncall/banking/transfer');
    expect(html).toContain('NOT ACTUALLY A CANTOR FITZGERALD');
  });

  test('posts the Fenics alert card to the Cognition Teams webhook, not Slack', async () => {
    process.env.ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI = TEAMS_URL;
    const res = await fetch(`${baseUrl}/api/oncall/trigger/banking`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ skin: SLUG, alertDestination: 'teams' }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, teams: true });
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
    const [url, payload] = axios.post.mock.calls[0];
    expect(url).toBe(TEAMS_URL);
    const card = JSON.stringify(payload.attachments[0].content);
    expect(card).toContain('EOD snapshot publish');
    expect(card).toContain('fmd-snapshot-publisher@2026.11.2');
    expect(card).not.toMatch(/Apex Bank|apex-bank/);
  });

  test('deploy trigger replays the failing publish with the skin header, then posts the alert', async () => {
    expect(parseArgs(['--base-url', 'https://example.test/', SLUG])).toEqual({ baseUrl: 'https://example.test', slugs: [SLUG] });
    const seen = [];
    const stub = express();
    stub.use(express.json());
    stub.post('/api/oncall/banking/transfer', (req, res) => {
      seen.push({ path: req.path, skin: req.get('x-oncall-skin'), body: req.body });
      res.status(504).json({ success: false, code: 'HOLD_EXPIRED' });
    });
    stub.post('/api/oncall/trigger/banking', (req, res) => {
      seen.push({ path: req.path, body: req.body });
      res.json({ ok: true, teams: true });
    });
    const stubServer = await new Promise((resolve) => { const s = stub.listen(0, () => resolve(s)); });
    try {
      const result = await triggerSkin(`http://127.0.0.1:${stubServer.address().port}`, SLUG);
      expect(result).toMatchObject({ slug: SLUG, requestStatus: 504, alertStatus: 200 });
      expect(seen[0]).toMatchObject({ path: '/api/oncall/banking/transfer', skin: SLUG, body: { fromAccount: 'FMD-FXV-EOD' } });
      expect(seen[1]).toMatchObject({ path: '/api/oncall/trigger/banking', body: { skin: SLUG, alertDestination: 'teams', unique: true } });
    } finally {
      stubServer.close();
    }
  });
});
