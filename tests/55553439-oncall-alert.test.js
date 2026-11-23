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

jest.mock('../app/services/devin-api', () => ({
  createDevinSession: jest.fn(),
}));

jest.mock('../app/services/devin-session', () => ({
  createSessionAndAlert: jest.fn(),
}));

jest.mock('../app/telemetry/sentry', () => ({
  Sentry: { captureException: jest.fn() },
  initSentry: jest.fn(),
}));

const { postMessage } = require('../app/services/slack');
const { createDevinSession } = require('../app/services/devin-api');
const { createSessionAndAlert } = require('../app/services/devin-session');
const { Sentry } = require('../app/telemetry/sentry');

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { startLivePlayback, resetAlertCooldown } = require('../app/services/verticals/55553439');

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('Live TV Watch Live failure as a Devin On-Call alert (55553439)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAlertCooldown();
  });

  test('scenario is unlisted and keeps code details out of the customer-facing lines', () => {
    const scenario = ALERT_SCENARIOS['55553439'];
    expect(scenario).toMatchObject({ unlisted: true, demoPage: '/55553439', service: 'customer-55553439-live-tv' });
    expect(`${scenario.symptom} ${scenario.impact}`).not.toMatch(/\.js|TypeError|buildAdPodSchedule|preroll/);
  });

  test('a failed news channel start reports to the shared Sentry and posts one card to the on-call alerts channel', async () => {
    await expect(startLivePlayback({ channelId: 'nbc-news-now' })).rejects.toThrow("reading 'preroll'");
    await expect(startLivePlayback({ channelId: 'nbc-news-now' })).rejects.toThrow();
    await flush();

    expect(Sentry.captureException).toHaveBeenCalledWith(expect.any(TypeError), expect.objectContaining({
      tags: expect.objectContaining({ customer: '55553439', alert_path: 'instant' }),
    }));
    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [, channel, text] = postMessage.mock.calls[0];
    expect(channel).toBe('C0TEST');
    expect(text).toContain('5xx rate — Watch Live');
    expect(text).toContain('*Affected page:* https://devindemos.com/55553439');
  });

  test('entertainment channels start without alerting', async () => {
    const result = await startLivePlayback({ channelId: 'law-order' });
    await flush();
    expect(result.success).toBe(true);
    expect(Sentry.captureException).not.toHaveBeenCalled();
    expect(postMessage).not.toHaveBeenCalled();
  });
});
