/* global afterAll, beforeAll, describe, expect, fetch, jest, test */

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

const oncallRoutes = require('../app/routes/oncall');
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

describe('0a42c36d Banco Almenara On-Call skin', () => {
  test('is a native banking skin for a fictional bank', () => {
    const skin = getOncallSkin('0a42c36d');
    expect(skin).toMatchObject({
      slug: '0a42c36d',
      company: 'Banco Almenara',
      vertical: 'banking',
      page: { file: '0a42c36d.html', title: 'Transferencias | Banco Almenara' },
    });
    expect(skin.disclaimer).toMatch(/^NOT ACTUALLY A BANCO ALMENARA SITE/);
  });

  test('serves the shimmed transfer page with the banking form contract', async () => {
    const res = await fetch(`${baseUrl}/oncall/c/0a42c36d`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('<title>Transferencias | Banco Almenara</title>');
    expect(html).toContain('NOT ACTUALLY A BANCO ALMENARA SITE');
    expect(html).toContain('const oncallApiPath = "/api/oncall/banking/transfer"');
    ['transferForm', 'fromAccount', 'toAccount', 'amount', 'accountTier', 'submitBtn', 'result']
      .forEach((id) => expect(html).toContain(`id="${id}"`));
    expect(html).not.toMatch(/Toledo/);
  });
});
