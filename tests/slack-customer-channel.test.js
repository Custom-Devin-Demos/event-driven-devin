/* global describe, expect, test, jest, beforeEach, afterEach */

jest.mock('axios');
const axios = require('axios');
const { postAlertToSlack, postPersonaMessage } = require('../app/services/slack');
const { getCustomerConfig } = require('../config/customers');

const ALERT = {
  issueTitle: 'TypeError: Cannot read properties of undefined',
  errorType: 'TypeError',
  errorValue: 'Cannot read properties of undefined',
  level: 'error',
  service: 'customer-0a537b71-mpi',
  customer: '0a537b71',
  tags: [],
};

describe('per-customer Slack channel override', () => {
  const savedToken = process.env.SLACK_BOT_TOKEN;
  const savedChannel = process.env.SLACK_CHANNEL_ID;
  const savedCustomerChannel = process.env.SLACK_CHANNEL_ID_0A537B71;

  beforeEach(() => {
    process.env.SLACK_BOT_TOKEN = 'xoxb-test';
    process.env.SLACK_CHANNEL_ID = 'C_GLOBAL';
    delete process.env.SLACK_CHANNEL_ID_0A537B71;
    axios.post.mockReset();
    axios.post.mockResolvedValue({ data: { ok: true, ts: '1.0' } });
  });

  afterEach(() => {
    if (savedToken === undefined) delete process.env.SLACK_BOT_TOKEN;
    else process.env.SLACK_BOT_TOKEN = savedToken;
    if (savedChannel === undefined) delete process.env.SLACK_CHANNEL_ID;
    else process.env.SLACK_CHANNEL_ID = savedChannel;
    if (savedCustomerChannel === undefined) delete process.env.SLACK_CHANNEL_ID_0A537B71;
    else process.env.SLACK_CHANNEL_ID_0A537B71 = savedCustomerChannel;
  });

  test('posts to customerConfig.slackChannelId when set', async () => {
    await postAlertToSlack({
      ...ALERT,
      customerConfig: { slackChannelId: 'C0C1FP3FM5K' },
    });

    expect(axios.post).toHaveBeenCalledTimes(1);
    expect(axios.post.mock.calls[0][1].channel).toBe('C0C1FP3FM5K');
  });

  test('posts NEXEN Monitoring alerts to the fixed SEV-1 channel', async () => {
    await postAlertToSlack({
      ...ALERT,
      service: 'customer-9bfabd45-web',
      customer: '9bfabd45',
      customerConfig: { slackChannelId: 'C0CJQDXKD9D' },
      slackPoster: { username: 'NEXEN Monitoring', icon_emoji: ':satellite_antenna:' },
    });

    expect(axios.post.mock.calls[0][1]).toMatchObject({
      channel: 'C0CJQDXKD9D',
      username: 'NEXEN Monitoring',
      icon_emoji: ':satellite_antenna:',
    });
  });

  test('falls back to SLACK_CHANNEL_ID when no override is set', async () => {
    await postAlertToSlack({ ...ALERT, customerConfig: { slackChannelId: '' } });

    expect(axios.post.mock.calls[0][1].channel).toBe('C_GLOBAL');
  });

  test('falls back to SLACK_CHANNEL_ID when customerConfig is absent', async () => {
    await postAlertToSlack({ ...ALERT });

    expect(axios.post.mock.calls[0][1].channel).toBe('C_GLOBAL');
  });

  test('uses the alert poster in the chat.postMessage body when provided', async () => {
    await postAlertToSlack({
      ...ALERT,
      slackPoster: { username: 'NEXEN Monitoring', icon_emoji: ':satellite_antenna:' },
    });

    expect(axios.post.mock.calls[0][1]).toMatchObject({
      username: 'NEXEN Monitoring',
      icon_emoji: ':satellite_antenna:',
    });
  });

  test('posts persona replies with the supplied thread timestamp', async () => {
    await postPersonaMessage(
      'xoxb-test',
      'C0CJQDXKD9D',
      'persona reply',
      'Maya Okafor',
      'https://example.test/maya.png',
      '1712345678.000100',
    );

    expect(axios.post.mock.calls[0][1]).toMatchObject({
      channel: 'C0CJQDXKD9D',
      text: 'persona reply',
      thread_ts: '1712345678.000100',
      username: 'Maya Okafor',
    });
  });

  test('does not add poster fields when no alert poster is provided', async () => {
    await postAlertToSlack({ ...ALERT });

    const body = axios.post.mock.calls[0][1];
    expect(body).not.toHaveProperty('username');
    expect(body).not.toHaveProperty('icon_url');
    expect(body).not.toHaveProperty('icon_emoji');
  });

  test('getCustomerConfig resolves the Tekion channel from the customer entry', () => {
    expect(getCustomerConfig('0a537b71').slackChannelId).toBe('C0C1FP3FM5K');
  });

  test('SLACK_CHANNEL_ID_0A537B71 env var wins over the customer entry', () => {
    process.env.SLACK_CHANNEL_ID_0A537B71 = 'C_ENV_OVERRIDE';
    expect(getCustomerConfig('0a537b71').slackChannelId).toBe('C_ENV_OVERRIDE');
  });

  test('customers without a channel configured resolve to empty', () => {
    expect(getCustomerConfig('a7fb8819').slackChannelId).toBe('');
    expect(getCustomerConfig('default').slackChannelId).toBe('');
  });
});
