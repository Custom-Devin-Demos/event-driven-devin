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
  createDevinSession: jest.fn().mockResolvedValue({
    sessionId: 'session-harvey',
    url: 'https://app.devin.ai/sessions/session-harvey',
  }),
}));

jest.mock('../app/services/sonar-pr-trigger', () => ({ scheduleVulnerablePR: jest.fn() }));

const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { getOncallSkin } = require('../config/oncall-skins');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0DEFAULT';

const { postOncallAlert, resetSkinAlertMemory } = require('../app/services/oncall');

const SHAHMIR = { orgId: 'org_69IXJFLrljx8zSAw', userId: 'email|69efcc3741b62dd9be352f7c', slack: 'U0B0ZNWTQ8G' };

describe('e63edc26 Harvey add-seats on-call skin', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSkinAlertMemory();
  });

  test('alerts #oncall-alerts and auto-starts a Devin session pinned to Shahmir', () => {
    const skin = getOncallSkin('e63edc26');
    expect(skin).toMatchObject({
      vertical: 'hightech',
      alertDestination: 'slack',
      slackChannelId: 'C0BNWUGCWBS',
      onCallSlackMemberId: SHAHMIR.slack,
      devinSession: { auto: true, pinIdentity: true, orgId: SHAHMIR.orgId, userId: SHAHMIR.userId },
    });
  });

  test('an alert posts to #oncall-alerts, starts the session as Shahmir and links it in the thread', async () => {
    const skin = getOncallSkin('e63edc26');
    const result = await postOncallAlert(skin.vertical, {
      skin, devinOrgId: 'org_someone_else', devinUserId: 'email|someoneelse',
    });

    expect(result).toMatchObject({ ok: true, channel: 'C0BNWUGCWBS', sessionUrl: 'https://app.devin.ai/sessions/session-harvey' });
    expect(postMessage.mock.calls[0][1]).toBe('C0BNWUGCWBS');
    expect(postMessage.mock.calls[0][2]).toContain(`<@${SHAHMIR.slack}>`);

    expect(createDevinSession).toHaveBeenCalledTimes(1);
    const [prompt, options] = createDevinSession.mock.calls[0];
    expect(options).toMatchObject({ orgId: SHAHMIR.orgId, userId: SHAHMIR.userId });
    expect(prompt).toContain('POST /api/oncall/licenses/provision');
    expect(prompt).toContain('/oncall/c/e63edc26');
    expect(prompt).toContain(`<@${SHAHMIR.slack}>`);

    expect(postThreadReply).toHaveBeenCalledWith(
      'xoxb-test', 'C0BNWUGCWBS', '1700000000.000100',
      expect.stringContaining('https://app.devin.ai/sessions/session-harvey'), expect.any(Array),
    );
  });
});
