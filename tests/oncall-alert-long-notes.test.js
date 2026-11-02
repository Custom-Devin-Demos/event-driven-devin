/* global describe, expect, jest, test */

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
const { postOncallAlert, resetSkinAlertMemory } = require('../app/services/oncall');
const { getOncallSkin } = require('../config/oncall-skins');

function lastBlocks() {
  return postMessage.mock.calls[postMessage.mock.calls.length - 1][3];
}

describe('on-call alert card with long responder notes', () => {
  test('splits notes over 3000 chars into several Slack sections, keeping every line', async () => {
    const paragraphs = Array.from({ length: 12 }, (_, i) => `Requirement ${i + 1}: ${'x'.repeat(300)}`);
    const notes = paragraphs.join('\n\n');
    expect(notes.length).toBeGreaterThan(3000);
    const base = getOncallSkin('9f836bf5');
    const skin = { ...base, slug: 'longnote', devinSession: { promptAppendix: notes } };

    if (resetSkinAlertMemory) resetSkinAlertMemory();
    await postOncallAlert(skin.vertical, { skin, runRef: 'run-test' });

    const sections = lastBlocks().filter((b) => b.type === 'section' && b.text);
    sections.forEach((b) => expect(b.text.text.length).toBeLessThanOrEqual(3000));
    const noteSections = sections.filter((b) => b.text.text.includes('Requirement'));
    expect(noteSections.length).toBeGreaterThan(1);
    const joined = noteSections.map((b) => b.text.text).join('\n\n');
    paragraphs.forEach((p) => expect(joined).toContain(p));
  });

  test('a single unbroken paragraph over 3000 chars is still split under the cap', async () => {
    const skin = { ...getOncallSkin('9f836bf5'), slug: 'longline', devinSession: { promptAppendix: 'y'.repeat(7000) } };
    if (resetSkinAlertMemory) resetSkinAlertMemory();
    await postOncallAlert(skin.vertical, { skin, runRef: 'run-test-2' });
    const noteSections = lastBlocks().filter((b) => b.type === 'section' && b.text && b.text.text.startsWith('y'));
    expect(noteSections.map((b) => b.text.text).join('')).toBe('y'.repeat(7000));
    noteSections.forEach((b) => expect(b.text.text.length).toBeLessThanOrEqual(3000));
  });
});
