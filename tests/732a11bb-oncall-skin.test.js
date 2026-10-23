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
const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { postOncallAlert } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

let server;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(oncallRoutes);
  app.use(express.static(path.join(__dirname, '..', 'app', 'public'), { index: false }));
  server = http.createServer(app);
  server.listen(0, done);
});

afterAll((done) => {
  server.closeAllConnections();
  server.close(() => stopGateway().then(() => done()));
});

describe('732a11bb inference on-call skin', () => {
  test('is configured to auto-create a Devin session', () => {
    const skin = getOncallSkin('732a11bb');
    expect(skin).toMatchObject({
      vertical: 'inference',
      oncallOnly: true,
      page: { file: '732a11bb.html', title: 'Build order | BEES Link' },
    });
    expect(skin.devinSession).toEqual({ auto: true, onCallIsTriggerer: true });
    expect(skin.bugPortal).toBeUndefined();
    expect(skin.incident).toBeUndefined();
  });

  test('posts an inference alert and links the auto-created session', async () => {
    const skin = getOncallSkin('732a11bb');
    const result = await postOncallAlert(skin.vertical, {
      skin,
      runRef: 'run-test',
      devinOrgId: 'org-723505993d234033a5b38f55ef48ef77',
      devinUserId: 'user-1cf9fa941c1847b5915a6eefe19c4eed',
      devinEmail: 'presenter@example.com',
    });

    expect(result.ok).toBe(true);
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [, channel, text] = postMessage.mock.calls[0];
    expect(channel).toBe('C0TEST');
    expect(text).toContain('/oncall/c/732a11bb');
    expect(text).toContain('*[Triggered] Order builder: p95 time to first drafted line trending up');

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [, options] = createDevinSession.mock.calls[0];
    expect(options.orgId).toBe('org-723505993d234033a5b38f55ef48ef77');
    expect(options.userId).toBe('user-1cf9fa941c1847b5915a6eefe19c4eed');
    expect(postThreadReply.mock.calls.map((call) => call.join(' ')).join(' ')).toContain('https://app.devin.ai/sessions/s');
  });
});
