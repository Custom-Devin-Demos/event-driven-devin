/* global beforeEach, describe, expect, jest, test */

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

jest.mock('../app/services/devin-api', () => ({ createDevinSession: jest.fn() }));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const { postOncallAlert, resetSkinAlertMemory } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

describe('e62af577 alert card', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSkinAlertMemory();
  });

  test('compact card, responder notes, no skin session and no SRE Bot thread replies', async () => {
    const skin = getOncallSkin('e62af577');
    const first = await postOncallAlert('research', { skin, unique: true });
    const repeat = await postOncallAlert('research', { skin, unique: true });
    expect(first.ok && repeat.ok).toBe(true);

    expect(createDevinSession).not.toHaveBeenCalled();
    expect(postThreadReply).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(2);

    const [, , text, blocks] = postMessage.mock.calls[0];
    const card = JSON.stringify(blocks);
    expect(card).toContain('Rogo research answers');
    expect(card).toContain('Incident Ref');
    expect(card).toContain('macOS child session');
    expect(card).not.toMatch(/Baseline|Events:|Monitor query|View in Datadog/);
    expect(blocks.some((b) => b.type === 'actions' || b.type === 'context')).toBe(false);
    expect(text).toContain('Monitor query');

    expect(JSON.stringify(postMessage.mock.calls[1][3])).not.toContain('Incident Ref');
  });
});
