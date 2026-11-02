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

process.env.SLACK_ONCALL_BOT_TOKEN = 'xoxb-test';
process.env.SLACK_ONCALL_ALERTS_CHANNEL_ID = 'C0TEST';

const { ALERT_SCENARIOS } = require('../app/services/oncall');
const { processInquiry, resetAlertCooldown } = require('../app/services/verticals/4d820a2b');

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

describe('T-Mobile Start your switch failure as a Devin On-Call alert (4d820a2b)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    resetAlertCooldown();
  });

  test('scenario is branded, unlisted and has no code details in the customer-facing lines', () => {
    const scenario = ALERT_SCENARIOS['4d820a2b'];
    expect(scenario).toMatchObject({ unlisted: true, demoPage: '/4d820a2b', service: 'customer-4d820a2b-switch' });
    expect(scenario.brand).toMatch(/T-Mobile/);
    expect(`${scenario.symptom} ${scenario.impact}`).not.toMatch(/\.js|TypeError|buildSwitchQuote/);
  });

  test('a failed switch offer posts one monitor card to the on-call alerts channel and starts no app session', async () => {
    await expect(processInquiry({ promotionId: 'switch-iphone18pro', lines: 3 })).rejects.toThrow();
    await expect(processInquiry({ promotionId: 'switch-iphone18pro', lines: 3 })).rejects.toThrow();
    await flush();

    expect(createSessionAndAlert).not.toHaveBeenCalled();
    expect(createDevinSession).not.toHaveBeenCalled();
    expect(postMessage).toHaveBeenCalledTimes(1);
    const [, channel, text, blocks] = postMessage.mock.calls[0];
    expect(channel).toBe('C0TEST');
    expect(text).toContain('5xx rate — Start your switch');
    expect(text).toContain('*Affected page:* https://devindemos.com/4d820a2b');
    expect(JSON.stringify(blocks)).toContain('customer-4d820a2b-switch (T-Mobile (Homepage Switch Offers))');
  });
});
