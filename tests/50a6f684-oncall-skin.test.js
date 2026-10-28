/* global afterAll, afterEach, beforeAll, beforeEach, describe, expect, jest, test */

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

const SLUG = '50a6f684';
const TITLE = 'ATORIS, 20mg, plėvele dengtos tabletės, N30 | Eurovaistine.lt';
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

describe('Euroapotheca e-prescription on-call skin (50a6f684)', () => {
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

  test('is a Teams-routed native insurance skin with no app-created Devin session', () => {
    const skin = getOncallSkin(SLUG);
    expect(skin).toMatchObject({
      vertical: 'insurance',
      oncallOnly: true,
      teamsAlerts: true,
      teamsWebhookEnv: 'ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI',
      alertDestination: 'teams',
      page: { file: `${SLUG}.html`, title: TITLE },
    });
    expect(skin.devinSession).toBeUndefined();
    expect(skin.alertCard.title).toMatch(/^5xx rate \u2014 /);
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A EUROAPOTHECA SITE/);
  });

  test('skin URL and customer aliases serve the same shimmed page', async () => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/oncall/c/${SLUG}`),
      fetch(`${baseUrl}/euroapotheca`),
      fetch(`${baseUrl}/eurovaistine`),
    ]);
    expect(responses.map((r) => r.status)).toEqual([200, 200, 200]);
    const [skinned, ...aliases] = await Promise.all(responses.map((r) => r.text()));
    aliases.forEach((html) => expect(html).toEqual(skinned));
    expect(skinned).toContain(`<title>${TITLE}</title>`);
    expect(skinned).toContain('id="claimForm"');
    expect(skinned).toContain('/api/oncall/insurance/claim');
    expect(skinned).toContain('NOT ACTUALLY A EUROAPOTHECA SITE');
  });

  test('alerts post only to the oncall-demo Teams channel', async () => {
    process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
    process.env.ONCALL_TEAMS_WEBHOOK_URL = TEAMS_URL;
    process.env.ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI = ONCALL_DEMO_URL;
    const skin = getOncallSkin(SLUG);
    const result = await postOncallAlert(skin.vertical, { skin, destination: skin.alertDestination });
    expect(result).toEqual({ ok: true, teams: true });
    expect(postMessage).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(axios.post).toHaveBeenCalledTimes(1);
    const [url, payload] = axios.post.mock.calls[0];
    expect(url).toBe(ONCALL_DEMO_URL);
    const card = JSON.stringify(payload.attachments[0].content);
    expect(card).toContain('5xx rate \u2014 e-prescription order submissions');
    expect(card).not.toMatch(/TypeError|app\/services|\.js:/);
  });
});
