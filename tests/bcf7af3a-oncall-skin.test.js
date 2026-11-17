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
  createDevinSession: jest.fn().mockResolvedValue({ sessionId: 'session-abc', url: 'https://app.devin.ai/sessions/session-abc' }),
}));

const express = require('express');
const http = require('http');
const axios = require('axios');
const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const oncallRoutes = require('../app/routes/oncall');
const { postOncallAlert, resetSkinAlertMemory } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

const TEAMS_URL = 'https://teams.example.test/workflows/hook';
const ONCALL_DEMO_URL = 'https://default8019.65.environment.api.powerplatform.com:443/powerautomate/automations/direct/workflows/abc/triggers/manual/paths/invoke?sig=x';
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

const SKINS = [
  { slug: 'bcf7af3a', vertical: 'banking', title: 'Banca en Línea | Banco General Panamá', form: 'id="transferForm"', endpoint: '/api/oncall/banking/transfer', card: 'Confirmar transferencia' },
  { slug: '9af9f631', vertical: 'insurance', title: 'Chat Estrella | Banco General Panamá', form: 'id="claimForm"', endpoint: '/api/oncall/insurance/claim', card: 'Chat Estrella messages (504)' },
];

describe.each(SKINS)('Banco General on-call skin $slug', ({ slug, vertical, title, form, endpoint, card }) => {
  beforeEach(() => {
    resetSkinAlertMemory();
    jest.clearAllMocks();
    axios.post.mockResolvedValue({ status: 202 });
    ENV_KEYS.forEach((k) => delete process.env[k]);
  });

  afterEach(() => {
    ENV_KEYS.forEach((k) => {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    });
  });

  test('is a Teams-routed native skin', () => {
    const skin = getOncallSkin(slug);
    expect(skin).toMatchObject({
      company: 'Banco General',
      vertical,
      oncallOnly: true,
      teamsAlerts: true,
      teamsWebhookEnv: 'ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI',
      alertDestination: 'teams',
      page: { file: `${slug}.html`, title },
    });
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A BANCO GENERAL SITE/);
  });

  test('serves the shimmed native page', async () => {
    const res = await fetch(`${baseUrl}/oncall/c/${slug}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<title>${title}</title>`);
    expect(html).toContain(form);
    expect(html).toContain(endpoint);
    expect(html).toContain('NOT ACTUALLY A BANCO GENERAL SITE');
  });

  test('alerts post only to the oncall-demo Teams channel', async () => {
    process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
    process.env.ONCALL_TEAMS_WEBHOOK_URL = TEAMS_URL;
    process.env.ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI = ONCALL_DEMO_URL;
    const skin = getOncallSkin(slug);
    const result = await postOncallAlert(skin.vertical, { skin, destination: skin.alertDestination });
    expect(result).toEqual({ ok: true, teams: true });
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, payload] = axios.post.mock.calls[0];
    expect(url).toBe(ONCALL_DEMO_URL);
    const text = JSON.stringify(payload.attachments[0].content);
    expect(text).toContain('Banco General');
    expect(text).toContain(card);
    expect(text).not.toMatch(/TypeError|app\/services|\.js:/);
  });
});
