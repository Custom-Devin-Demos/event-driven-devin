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

  test('fresh alert: compact card, one macOS session, no SRE Bot replies; repeats group onto the original', async () => {
    createDevinSession.mockResolvedValue({ sessionId: 's1', url: 'https://devin.example/sessions/s1' });
    const skin = getOncallSkin('e62af577');
    const first = await postOncallAlert('research', { skin, unique: true });
    const second = await postOncallAlert('research', { skin, unique: true });
    const third = await postOncallAlert('research', { skin, unique: true });
    expect(first.ok && second.ok && third.ok).toBe(true);

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt, opts] = createDevinSession.mock.calls[0];
    expect(opts.platform).toBe('macos');
    expect(prompt).toContain('Slack Thread:* channel=C0TEST thread_ts=1700000000.000100');
    expect(prompt).toContain('ONE Simulator recording');
    expect(postThreadReply).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(3);

    const [, , text, blocks] = postMessage.mock.calls[0];
    const card = JSON.stringify(blocks);
    expect(card).toContain('Rogo research answers');
    expect(card).toContain('Incident Ref');
    expect(card).not.toMatch(/Baseline|Events:|Monitor query|View in Datadog|Simulator|Grouped with/);
    expect(blocks.some((b) => b.type === 'actions' || b.type === 'context')).toBe(false);
    expect(text).toContain('Monitor query');
    expect(text).toContain('rogo-research@');

    const permalink = 'https://coggtm.slack.com/archives/C0TEST/p1700000000000100';
    const secondCard = JSON.stringify(postMessage.mock.calls[1][3]);
    expect(secondCard).not.toContain('Incident Ref');
    expect(secondCard).toContain(`<${permalink}|original alert> · 1 previous run ·`);
    expect(JSON.stringify(postMessage.mock.calls[2][3])).toContain('· 2 previous runs ·');
    expect(postMessage.mock.calls[1][2]).toContain('rogo-research@');
  });
});
