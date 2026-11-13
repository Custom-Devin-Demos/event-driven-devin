/* global afterAll, beforeAll, beforeEach, describe, expect, fetch, jest, test */

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

const { postMessage, postThreadReply } = require('../app/services/slack');
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
  server.closeAllConnections();
  server.close(done);
});

describe('a8d903f4 Santander UK Online Banking On-Call skin', () => {
  beforeEach(() => jest.clearAllMocks());

  test('is a native banking skin that auto-starts a Devin session for the presenter', () => {
    const skin = getOncallSkin('a8d903f4');
    expect(skin).toMatchObject({
      company: 'Santander UK',
      vertical: 'banking',
      oncallOnly: true,
      paths: ['/santander-uk-oncall'],
      page: { file: 'a8d903f4.html', title: 'Pay someone | Santander Online Banking' },
    });
    expect(skin.devinSession).toEqual({ auto: true, onCallIsTriggerer: true });
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A SANTANDER SITE/);
    for (const value of Object.values(skin.alertCard)) {
      expect(value).not.toMatch(/santander/i);
    }
    expect(getOncallSkin('80565c6b').devinSession).toBeUndefined();
  });

  test('skin URL, direct slug and alias serve the same shimmed Pay someone page', async () => {
    const paths = ['/oncall/c/a8d903f4', '/a8d903f4', '/santander-uk-oncall'];
    const pages = await Promise.all(paths.map(async (p) => {
      const res = await fetch(`${baseUrl}${p}`);
      expect(res.status).toBe(200);
      return res.text();
    }));
    const html = pages[0];
    pages.slice(1).forEach((page) => expect(page).toEqual(html));
    expect(html).toContain('<title>Pay someone | Santander Online Banking</title>');
    expect(html).toContain('Confirm payment');
    expect(html).toContain("fetch('/api/banking/transfer'");
    expect(html).toContain('const oncallApiPath = "/api/oncall/banking/transfer"');
    expect(html).toContain('NOT ACTUALLY A SANTANDER SITE');
    ['transferForm', 'fromAccount', 'toAccount', 'amount', 'accountTier', 'submitBtn', 'result']
      .forEach((id) => expect(html).toContain(`id="${id}"`));
    expect(html).not.toContain('All Demos');
  });

  test('posts a payments latency card and starts the session as the triggering presenter', async () => {
    const skin = getOncallSkin('a8d903f4');
    const result = await postOncallAlert(skin.vertical, {
      skin,
      runRef: 'run-test',
      devinOrgId: 'org-723505993d234033a5b38f55ef48ef77',
      devinUserId: 'user-1cf9fa941c1847b5915a6eefe19c4eed',
      devinEmail: 'presenter@example.com',
    });

    expect(result.ok).toBe(true);
    const [, channel, text] = postMessage.mock.calls[postMessage.mock.calls.length - 1];
    expect(channel).toBe('C0TEST');
    expect(text).toContain('Online Banking: pay an existing payee');
    expect(text).toContain('*Endpoint:* POST /api/oncall/banking/transfer');
    expect(text).toContain('*Metric value:* 9.4s | *Threshold:* > 1.5s');
    expect(text).toContain('uk-digital-payments-oncall');
    expect(text).toContain('Release: olb-payments@2026.11.1');
    expect(text).toContain('/oncall/c/a8d903f4');

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [, options] = createDevinSession.mock.calls[0];
    expect(options.orgId).toBe('org-723505993d234033a5b38f55ef48ef77');
    expect(options.userId).toBe('user-1cf9fa941c1847b5915a6eefe19c4eed');
    expect(postThreadReply.mock.calls.map((call) => call.join(' ')).join(' ')).toContain('https://app.devin.ai/sessions/s');
  });
});
