const axios = require('axios');
const logger = require('../telemetry/logger');
const { sendDevinSessionMessage } = require('./devin-api');

async function pageBot({
  botId,
  message,
  webhookUrl,
  webhookSecret,
  identity,
  context = {},
  payload = {},
}) {
  if (webhookUrl) {
    try {
      const response = await axios.post(webhookUrl, {
        bot_id: botId || null,
        message,
        source: 'devindemos.com',
        ...context,
        ...payload,
      }, {
        headers: {
          'Content-Type': 'application/json',
          ...(webhookSecret ? { 'X-Webhook-Secret': webhookSecret } : {}),
        },
        timeout: 15000,
      });
      return { via: 'webhook', status: response.status };
    } catch (err) {
      logger.error('Bot webhook page failed', {
        botId,
        status: err.response?.status,
      });
      return null;
    }
  }

  if (!botId) return null;
  const response = await sendDevinSessionMessage(botId, message, identity);
  return response ? { via: 'v3', ...response } : null;
}

module.exports = { pageBot };
