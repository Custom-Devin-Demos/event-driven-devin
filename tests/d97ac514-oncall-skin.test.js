/* global afterAll, afterEach, beforeAll, beforeEach, describe, expect, fetch, jest, test */

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

jest.mock('../app/services/sonar-pr-trigger', () => ({
  scheduleVulnerablePR: jest.fn(),
}));

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const express = require('express');
const http = require('http');

const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const oncallRoutes = require('../app/routes/oncall');
const { postOncallAlert } = require('../app/services/oncall');
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

describe('d97ac514 Bank of America Transfer On-Call skin', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  test('is a native banking skin pinned to Slack, separate from f2686bda', () => {
    const skin = getOncallSkin('d97ac514');
    expect(skin).toMatchObject({
      company: 'Bank of America',
      vertical: 'banking',
      oncallOnly: true,
      alertDestination: 'slack',
      paths: ['/bofa-transfer-oncall'],
      triggerWhen: { accountTier: 'standard' },
      page: { file: 'd97ac514.html' },
    });
    expect(skin.devinSession).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A BANK OF AMERICA SITE/);
    for (const value of Object.values(skin.alertCard)) {
      expect(value).not.toMatch(/bank of america|bofa|apex/i);
    }

    const original = getOncallSkin('f2686bda');
    expect(original.page.file).toBe('f2686bda.html');
    expect(original.alertCard).toBeUndefined();
    expect(original.paths).toBeUndefined();
  });

  test('skin URL, direct slug and alias serve the same shimmed Transfer page', async () => {
    const paths = ['/oncall/c/d97ac514', '/d97ac514', '/bofa-transfer-oncall'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain('Transfer between my accounts');
    expect(html).toContain("fetch('/api/banking/transfer'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/banking/transfer"');
    expect(html).toContain('const triggerWhen = {"accountTier":"standard"}');
    expect(html).toContain('NOT ACTUALLY A BANK OF AMERICA SITE');
    ['transferForm', 'fromAccount', 'toAccount', 'amount', 'accountTier', 'submitBtn', 'result']
      .forEach((id) => expect(html).toContain(`id="${id}"`));
    expect(html).toMatch(/<option value="standard">[^<]+<\/option>/);
    expect(html).toMatch(/<option value="premium">[^<]+<\/option>/);
  });

  test('posts a transfer latency card in its own language and starts no app session', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const skin = getOncallSkin('d97ac514');
    await postOncallAlert(skin.vertical, { skin, runRef: 'run-test' });
    const [, , text] = postMessage.mock.calls[postMessage.mock.calls.length - 1];

    expect(text).toContain(':rotating_light: *[Triggered] p95 latency spike — Transfer between my accounts*');
    expect(text).toContain('*Service:* transfers-api (Bank of America)');
    expect(text).toContain('*Endpoint:* POST /api/oncall/banking/transfer');
    expect(text).toContain('*Metric value:* 9.6s | *Threshold:* > 1.5s');
    expect(text).toContain('digital-payments-oncall');
    expect(text).toContain('Release: olb-transfers@26.10.2');
    expect(text).toContain('/oncall/c/d97ac514');
    expect(text).not.toMatch(/apex/i);
    expect(createDevinSession).not.toHaveBeenCalled();
  });
});
