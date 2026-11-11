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

const SLUG = '2179350e';
const TITLE = 'BNZ - Pay someone | Internet Banking';
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

describe('2179350e BNZ Pay someone On-Call skin', () => {
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

  test('is a Teams-routed native banking skin with Splunk/Dynatrace wording', () => {
    const skin = getOncallSkin(SLUG);
    expect(skin).toMatchObject({
      company: 'BNZ',
      vertical: 'banking',
      oncallOnly: true,
      teamsAlerts: true,
      teamsWebhookEnv: 'ONCALL_TEAMS_WEBHOOK_URL_COGNITION_AI',
      alertDestination: 'teams',
      telemetryBrand: 'splunk-dynatrace',
      page: { file: `${SLUG}.html`, title: TITLE },
    });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.alertCard.metricQuery).toContain('service:banking-api uri_path="/api/oncall/banking/transfer"');
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A BNZ SITE/);
  });

  test('serves the shimmed Pay someone page with the standard banking form ids', async () => {
    const res = await fetch(`${baseUrl}/oncall/c/${SLUG}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain(`<title>${TITLE}</title>`);
    expect(html).toContain("fetch('/api/banking/transfer'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/banking/transfer"');
    expect(html).toContain('NOT ACTUALLY A BNZ SITE');
    expect(html).toContain('var skinAlertDestination = "teams"');
    ['transferForm', 'fromAccount', 'toAccount', 'amount', 'accountTier', 'submitBtn', 'result']
      .forEach((id) => expect(html).toContain(`id="${id}"`));
    expect(html).toMatch(/<option value="standard" selected>/);
    expect(html).toMatch(/02-0192-0284915-00/);
  });

  test('alert posts a Dynatrace-worded Pay someone card to Teams only', async () => {
    process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';
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
    expect(card).toContain('Response time degradation');
    expect(card).toContain('ib-payments@2026.11.0');
    expect(card).toContain('Dynatrace problem');
    expect(card).toContain('banking-api (BNZ)');
    expect(card).not.toMatch(/Apex Bank|apex-bank|Datadog/);
  });
});
