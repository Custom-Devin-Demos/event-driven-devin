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

describe('085d0475 credit decision On-Call skin', () => {
  beforeEach(() => jest.clearAllMocks());
  afterEach(() => jest.restoreAllMocks());

  test('is a native banking skin pinned to Slack with a brand-free alert card', () => {
    const skin = getOncallSkin('085d0475');
    expect(skin).toMatchObject({
      vertical: 'banking',
      oncallOnly: true,
      alertDestination: 'slack',
      paths: ['/dnb'],
      triggerWhen: { accountTier: 'standard' },
      page: { file: '085d0475.html' },
      alertCard: { release: 'credit-decisioning@2026.11.2', team: 'credit-decisioning-oncall' },
    });
    expect(skin.devinSession).toBeUndefined();
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A [A-Z& ]+ SITE/);
    const brand = new RegExp(skin.company.split(' ')[0] + '|apex', 'i');
    for (const value of Object.values(skin.alertCard)) {
      expect(value).not.toMatch(brand);
    }
  });

  test('skin URL, direct slug and alias serve the same shimmed credit report page', async () => {
    const paths = ['/oncall/c/085d0475', '/085d0475', '/dnb'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain('<title>Business Credit Report | D&amp;B Finance Analytics</title>');
    expect(html).toContain('fetch("/api/banking/transfer"');
    expect(html).toContain('const oncallApiPath = "/api/oncall/banking/transfer"');
    expect(html).toContain('const triggerWhen = {"accountTier":"standard"}');
    ['transferForm', 'fromAccount', 'toAccount', 'amount', 'accountTier', 'submitBtn', 'result']
      .forEach((id) => expect(html).toContain(`id="${id}"`));
    expect(html).toMatch(/<option value="standard" selected>[^<]+<\/option>/);
    expect(html).toMatch(/<option value="premium">[^<]+<\/option>/);
  });

  test('report and incident surfaces are not opted in', async () => {
    for (const p of ['/oncall/c/085d0475/report', '/oncall/c/085d0475/incident']) {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(404);
    }
  });

  test('posts a credit decision latency card to #oncall-alerts and starts no app session', async () => {
    jest.spyOn(Math, 'random').mockReturnValue(0);
    const skin = getOncallSkin('085d0475');
    await postOncallAlert(skin.vertical, { skin, runRef: 'run-test' });
    const [, , text] = postMessage.mock.calls[postMessage.mock.calls.length - 1];

    expect(text).toContain('*[Triggered] p95 latency — Get credit decision (new account)*');
    expect(text).toContain('*Endpoint:* POST /api/oncall/banking/transfer');
    expect(text).toContain('*Metric value:* 9.2s | *Threshold:* > 2s');
    expect(text).toContain('credit-decisioning-oncall');
    expect(text).toContain('Release: credit-decisioning@2026.11.2');
    expect(text).toContain('/oncall/c/085d0475');
    expect(text).not.toMatch(/apex/i);
    expect(createDevinSession).not.toHaveBeenCalled();
  });
});
