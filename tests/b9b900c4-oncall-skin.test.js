/* global beforeEach, describe, expect, jest, test */

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

const { postMessage } = require('../app/services/slack');
const { postOncallAlert } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

describe('b9b900c4 Otter.ai On-Call skin', () => {
  beforeEach(() => jest.clearAllMocks());

  test('alert card names the Otter release, not the stock voice release', async () => {
    const skin = getOncallSkin('b9b900c4');
    expect(skin).toMatchObject({
      vertical: 'voice',
      alertCard: { release: 'otter-transcribe@3.12.0', team: 'otter-transcription-oncall' },
    });

    await postOncallAlert(skin.vertical, { skin, runRef: 'run-test' });
    const [, , text] = postMessage.mock.calls[postMessage.mock.calls.length - 1];

    expect(text).toContain('Otter transcript finalize p95 climbing');
    expect(text).toContain('Release: otter-transcribe@3.12.0');
    expect(text).toContain('otter-transcription-oncall');
    expect(text).toContain('before otter-transcribe@3.12.0');
    expect(text).not.toMatch(/echoscribe/i);
  });
});
