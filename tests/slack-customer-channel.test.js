/* global describe, expect, test, jest, beforeEach, afterEach */

jest.mock('axios');
const axios = require('axios');
const { postAlertToSlack } = require('../app/services/slack');
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

  test('falls back to SLACK_CHANNEL_ID when no override is set', async () => {
    await postAlertToSlack({ ...ALERT, customerConfig: { slackChannelId: '' } });

    expect(axios.post.mock.calls[0][1].channel).toBe('C_GLOBAL');
  });

  test('falls back to SLACK_CHANNEL_ID when customerConfig is absent', async () => {
    await postAlertToSlack({ ...ALERT });

    expect(axios.post.mock.calls[0][1].channel).toBe('C_GLOBAL');
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
