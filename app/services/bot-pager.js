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
      const body = err.response?.data;
      logger.error('Bot webhook page failed', {
        botId,
        status: err.response?.status,
        body: typeof body === 'string' ? body.slice(0, 500) : JSON.stringify(body ?? null).slice(0, 500),
        error: err.code || err.message,
      });
      return null;
    }
  }

  if (!botId) return null;
  const response = await sendDevinSessionMessage(botId, message, identity);
  return response ? { via: 'v3', ...response } : null;
}

module.exports = { pageBot };
