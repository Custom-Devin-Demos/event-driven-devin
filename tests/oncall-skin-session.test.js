jest.mock('../app/services/slack', () => ({
  OWNER_DISCLAIMER: 'fictional on-call persona',
  postMessage: jest.fn().mockResolvedValue('1700000000.000100'),
  postThreadReply: jest.fn().mockResolvedValue('1700000000.000200'),
  lookupSlackUserByEmail: jest.fn().mockResolvedValue(null),
  findChannelByNameFragment: jest.fn().mockResolvedValue(null),
  joinChannel: jest.fn().mockResolvedValue(undefined),
  postPersonaMessage: jest.fn().mockResolvedValue(undefined),
  inviteToChannel: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn().mockResolvedValue({
    sessionId: 'session-abc',
    url: 'https://app.devin.ai/sessions/session-abc',
  }),
}));

const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { getOncallSkin } = require('../config/oncall-skins');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const { postOncallAlert } = require('../app/services/oncall');

const AUTO_SKIN_SLUG = '4b663efb';

describe('on-call alerts that auto-create a Devin session', () => {
  beforeEach(() => jest.clearAllMocks());

  test('an opted-in skin creates one session and links it in the alert thread', async () => {
    const skin = getOncallSkin(AUTO_SKIN_SLUG);
    const result = await postOncallAlert(skin.vertical, { skin });

    expect(result.ok).toBe(true);
    expect(createDevinSession).toHaveBeenCalledTimes(1);

    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options.orgId).toBe(skin.devinSession.orgId);
    expect(prompt).toContain('POST /api/oncall/marketplace/cart');
    expect(prompt).toContain(`/oncall/c/${skin.slug}`);
    expect(prompt).not.toMatch(/\.js:|at Object\.|app\/services/);

    expect(postThreadReply).toHaveBeenCalledWith(
      'xoxb-test',
      'C0TEST',
      await postMessage.mock.results[0].value,
      expect.stringContaining('https://app.devin.ai/sessions/session-abc'),
      expect.any(Array),
    );
    expect(result.sessionUrl).toBe('https://app.devin.ai/sessions/session-abc');
  });

  test('a generic alert with no skin stays alert-only', async () => {
    const result = await postOncallAlert('marketplace');

    expect(result.ok).toBe(true);
    expect(result.sessionUrl).toBeUndefined();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(postThreadReply).not.toHaveBeenCalled();
  });

  test('a skin that did not opt in stays alert-only', async () => {
    const skin = getOncallSkin('63dbb52f');
    expect(skin.devinSession).toBeUndefined();

    const result = await postOncallAlert(skin.vertical, { skin });

    expect(result.ok).toBe(true);
    expect(result.sessionUrl).toBeUndefined();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(postThreadReply).not.toHaveBeenCalled();
  });

  test('a failed session creation still leaves the alert posted', async () => {
    createDevinSession.mockRejectedValueOnce(new Error('devin api down'));

    const result = await postOncallAlert('marketplace', { skin: getOncallSkin(AUTO_SKIN_SLUG) });

    expect(result.ok).toBe(true);
    expect(result.sessionUrl).toBeUndefined();
    expect(postThreadReply).not.toHaveBeenCalled();
  });
});
