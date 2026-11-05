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

describe('3a206b9a Equifax ANZ credit enquiry On-Call skin', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  test('is a native banking skin pinned to Slack with a brand-free alert card', () => {
    const skin = getOncallSkin('3a206b9a');
    expect(skin).toMatchObject({
      company: 'Equifax',
      vertical: 'banking',
      oncallOnly: true,
      alertDestination: 'slack',
      paths: ['/equifax-oncall', '/equifax-anz-oncall'],
      triggerWhen: { accountTier: 'standard' },
      page: { file: '3a206b9a.html' },
    });
    expect(skin.devinSession).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY AN EQUIFAX SITE/);
    for (const value of Object.values(skin.alertCard)) {
      expect(value).not.toMatch(/equifax|apex/i);
    }
  });

  test('skin URL, direct slug and aliases serve the same shimmed enquiry page', async () => {
    const paths = ['/oncall/c/3a206b9a', '/3a206b9a', '/equifax-oncall', '/equifax-anz-oncall'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain('<title>New consumer credit enquiry | Equifax Business Portal</title>');
    expect(html).toContain("fetch('/api/banking/transfer'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/banking/transfer"');
    expect(html).toContain('const triggerWhen = {"accountTier":"standard"}');
    expect(html).toContain('NOT ACTUALLY AN EQUIFAX SITE');
    ['transferForm', 'fromAccount', 'toAccount', 'amount', 'accountTier', 'submitBtn', 'result']
      .forEach((id) => expect(html).toContain(`id="${id}"`));
    expect(html).toMatch(/<option value="standard" selected>[^<]+<\/option>/);
    expect(html).toMatch(/<option value="premium">[^<]+<\/option>/);
  });

  test('posts an enquiry latency card to #oncall-alerts and starts no app session', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const skin = getOncallSkin('3a206b9a');
    await postOncallAlert(skin.vertical, { skin, runRef: 'run-test' });
    const [, , text] = postMessage.mock.calls[postMessage.mock.calls.length - 1];

    expect(text).toContain(':rotating_light: *[Triggered] p95 latency — Consumer credit enquiry (comprehensive)*');
    expect(text).toContain('*Service:* consumer-enquiry-api (Equifax)');
    expect(text).toContain('*Endpoint:* POST /api/oncall/banking/transfer');
    expect(text).toContain('*Metric value:* 9.4s | *Threshold:* > 2s');
    expect(text).toContain('anz-bureau-platform');
    expect(text).toContain('Release: enquiry-gateway@2026.11.1');
    expect(text).toContain('/oncall/c/3a206b9a');
    expect(text).not.toMatch(/apex/i);
    expect(createDevinSession).not.toHaveBeenCalled();
  });
});
