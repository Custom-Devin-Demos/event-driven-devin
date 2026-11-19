jest.mock('axios', () => ({
  post: jest.fn(),
}));

jest.mock('../app/telemetry/logger', () => ({
  error: jest.fn(),
}));

jest.mock('../app/services/devin-api', () => ({
  sendDevinSessionMessage: jest.fn(),
}));

const axios = require('axios');
const logger = require('../app/telemetry/logger');
const { sendDevinSessionMessage } = require('../app/services/devin-api');
const { pageBot } = require('../app/services/bot-pager');

describe('pageBot', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('posts to the webhook with the secret header and merged payload', async () => {
    axios.post.mockResolvedValue({ status: 202 });
    const identity = { orgId: 'org-1', userId: 'user-1' };
    const result = await pageBot({
      botId: 'bot-123',
      message: 'Please investigate.',
      webhookUrl: 'https://automation.example.test/hook',
      webhookSecret: 'unit-test-secret',
      identity,
      context: { channel_id: 'C123' },
      payload: { incident: 'Settlement SEV-1', reference: 'ref-1' },
    });

    expect(axios.post).toHaveBeenCalledWith(
      'https://automation.example.test/hook',
      {
        bot_id: 'bot-123',
        message: 'Please investigate.',
        source: 'devindemos.com',
        channel_id: 'C123',
        incident: 'Settlement SEV-1',
        reference: 'ref-1',
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Webhook-Secret': 'unit-test-secret',
        },
        timeout: 15000,
      },
    );
    expect(result).toEqual({ via: 'webhook', status: 202 });
    expect(sendDevinSessionMessage).not.toHaveBeenCalled();
  });

  test('returns null when the webhook request fails', async () => {
    axios.post.mockRejectedValue(new Error('network failure'));

    await expect(pageBot({
      botId: 'bot-123',
      message: 'Please investigate.',
      webhookUrl: 'https://automation.example.test/hook',
      webhookSecret: 'unit-test-secret',
    })).resolves.toBeNull();

    expect(logger.error).toHaveBeenCalledWith('Bot webhook page failed', {
      botId: 'bot-123',
      status: undefined,
    });
  });

  test('falls back to the v3 messages API when no webhook URL is provided', async () => {
    sendDevinSessionMessage.mockResolvedValue({ sessionId: 'bot-123', url: 'https://devin.example/session' });
    const identity = { orgId: 'org-1', userId: 'user-1' };

    await expect(pageBot({
      botId: 'bot-123',
      message: 'Please investigate.',
      identity,
    })).resolves.toEqual({
      via: 'v3',
      sessionId: 'bot-123',
      url: 'https://devin.example/session',
    });

    expect(sendDevinSessionMessage).toHaveBeenCalledWith('bot-123', 'Please investigate.', identity);
    expect(axios.post).not.toHaveBeenCalled();
  });
});
