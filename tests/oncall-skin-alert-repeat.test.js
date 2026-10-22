/* global afterEach, beforeEach, describe, expect, jest, test */

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
  createDevinSession: jest.fn(),
}));

jest.mock('../app/services/sonar-pr-trigger', () => ({
  scheduleVulnerablePR: jest.fn(),
}));

const { postMessage, postThreadReply } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { getOncallSkin, ONCALL_SKINS } = require('../config/oncall-skins');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const {
  postOncallAlert, resetSkinAlertMemory, SKIN_ALERT_REPEAT_WINDOW_MS,
} = require('../app/services/oncall');

const NOW = new Date('2026-10-21T22:00:00.000Z');
const SKIN = getOncallSkin('12d591ae');

function lastAlertText() {
  return postMessage.mock.calls[postMessage.mock.calls.length - 1][2];
}

describe('repeat alerts from one skin group into the open incident', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetSkinAlertMemory();
    jest.useFakeTimers({ now: NOW, doNotFake: ['nextTick', 'setImmediate'] });
    let n = 0;
    createDevinSession.mockImplementation(async () => {
      n += 1;
      return { sessionId: `s${n}`, url: `https://app.devin.ai/sessions/s${n}` };
    });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('first alert gets an Incident Ref and a Devin session; a repeat inside the window gets neither', async () => {
    const first = await postOncallAlert(SKIN.vertical, { skin: SKIN });
    expect(first.ok).toBe(true);
    expect(first.grouped).toBeUndefined();
    expect(first.sessionUrl).toBe('https://app.devin.ai/sessions/s1');
    expect(lastAlertText()).toMatch(/\*Incident Ref:\* run-[0-9a-f]{12}/);
    expect(createDevinSession).toHaveBeenCalledTimes(1);

    jest.setSystemTime(NOW.getTime() + 90 * 1000);
    const second = await postOncallAlert(SKIN.vertical, { skin: SKIN });
    expect(second.ok).toBe(true);
    expect(second.grouped).toBe(true);
    expect(second.sessionUrl).toBe('https://app.devin.ai/sessions/s1');
    expect(lastAlertText()).not.toContain('Incident Ref');
    expect(createDevinSession).toHaveBeenCalledTimes(1);

    // The repeat's thread still links the session already investigating.
    expect(postThreadReply).toHaveBeenCalledTimes(2);
    expect(postThreadReply.mock.calls[1][3]).toContain('https://app.devin.ai/sessions/s1');
  });

  test('after the window elapses the next alert is a fresh incident', async () => {
    await postOncallAlert(SKIN.vertical, { skin: SKIN });
    jest.setSystemTime(NOW.getTime() + SKIN_ALERT_REPEAT_WINDOW_MS + 1000);
    const next = await postOncallAlert(SKIN.vertical, { skin: SKIN });
    expect(next.grouped).toBeUndefined();
    expect(next.sessionUrl).toBe('https://app.devin.ai/sessions/s2');
    expect(lastAlertText()).toMatch(/\*Incident Ref:\* run-[0-9a-f]{12}/);
    expect(createDevinSession).toHaveBeenCalledTimes(2);
  });

  test('skins are tracked independently and alertRepeatWindowMs: 0 opts out', async () => {
    const other = { ...getOncallSkin('9996f438') };
    await postOncallAlert(SKIN.vertical, { skin: SKIN });
    const otherFirst = await postOncallAlert(other.vertical, { skin: other });
    expect(otherFirst.grouped).toBeUndefined();
    expect(createDevinSession).toHaveBeenCalledTimes(2);

    const optOut = { ...SKIN, slug: 'optout00', alertRepeatWindowMs: 0 };
    await postOncallAlert(optOut.vertical, { skin: optOut });
    const again = await postOncallAlert(optOut.vertical, { skin: optOut });
    expect(again.grouped).toBeUndefined();
    expect(lastAlertText()).toContain('Incident Ref');
    expect(createDevinSession).toHaveBeenCalledTimes(4);
  });

  test('an explicit runRef is always honoured as its own incident', async () => {
    await postOncallAlert(SKIN.vertical, { skin: SKIN });
    const explicit = await postOncallAlert(SKIN.vertical, { skin: SKIN, runRef: 'run-explicit' });
    expect(explicit.grouped).toBeUndefined();
    expect(lastAlertText()).toContain('*Incident Ref:* run-explicit');
  });
});

describe('skin investigation prompts never send Devin to the live page', () => {
  const withPrompts = Object.values(ONCALL_SKINS)
    .filter((skin) => skin.devinSession && typeof skin.devinSession.promptAppendix === 'string');

  test('at least the banking demo skins carry a prompt appendix', () => {
    expect(withPrompts.map((s) => s.slug)).toEqual(expect.arrayContaining(['12d591ae', '9996f438', '0a1c49ed']));
  });

  test.each(withPrompts.map((skin) => [skin.slug, skin.devinSession.promptAppendix]))(
    '%s records BEFORE on a local run, not on devindemos.com',
    (slug, appendix) => {
      expect(appendix).not.toMatch(/BEFORE on the live page/);
      expect(appendix).not.toMatch(/live page still hangs/);
      if (/BEFORE/.test(appendix)) {
        expect(appendix).toMatch(/BEFORE on a local run/);
        expect(appendix).toMatch(/Never open or submit the live page/);
      }
    },
  );
});
