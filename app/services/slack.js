const axios = require('axios');
const logger = require('../telemetry/logger');

const SLACK_API_BASE = 'https://slack.com/api';

/**
 * Post a message to a Slack channel.
 * Returns the message timestamp (ts) for threading replies.
 */
async function postMessage(token, channel, text, blocks) {
  const body = { channel, text };
  if (blocks) {
    body.blocks = blocks;
  }

  const response = await axios.post(`${SLACK_API_BASE}/chat.postMessage`, body, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  if (!response.data.ok) {
    throw new Error(`Slack API error: ${response.data.error}`);
  }

  return response.data.ts;
}

/**
 * Reply in a Slack thread.
 */
async function postThreadReply(token, channel, threadTs, text, blocks) {
  const body = { channel, text, thread_ts: threadTs };
  if (blocks) {
    body.blocks = blocks;
  }

  const response = await axios.post(`${SLACK_API_BASE}/chat.postMessage`, body, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  if (!response.data.ok) {
    throw new Error(`Slack API error: ${response.data.error}`);
  }

  return response.data.ts;
}

/**
 * Build Slack blocks for the initial Sentry alert message.
 */
function buildAlertBlocks(alertData) {
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: `:rotating_light: Sentry Alert — ${alertData.verticalLabel || 'Checkout'} Error`,
        emoji: true,
      },
    },
    {
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Error:*\n${alertData.issueTitle}`,
        },
        {
          type: 'mrkdwn',
          text: `*Severity:*\n${alertData.level || 'error'}`,
        },
      ],
    },
  ];

  if (alertData.culprit || alertData.errorType) {
    blocks.push({
      type: 'section',
      fields: [
        {
          type: 'mrkdwn',
          text: `*Location:*\n\`${alertData.culprit || 'unknown'}\``,
        },
        {
          type: 'mrkdwn',
          text: `*Type:*\n${alertData.errorType || 'unknown'}`,
        },
      ],
    });
  }

  if (alertData.errorValue) {
    blocks.push({
      type: 'section',
      text: {
        type: 'mrkdwn',
        text: `*Message:*\n\`\`\`${alertData.errorValue}\`\`\``,
      },
    });
  }

  blocks.push({
    type: 'section',
    fields: [
      {
        type: 'mrkdwn',
        text: `*Release:*\n${alertData.release || process.env.SENTRY_RELEASE || 'acme-checkout@1.0.2'}`,
      },
      {
        type: 'mrkdwn',
        text: `*Environment:*\n${alertData.environment || process.env.DD_ENV || 'prod'}`,
      },
    ],
  });

  const devinUserId = process.env.DEVIN_SLACK_USER_ID || 'U08RNEJ4877';
  blocks.push({
    type: 'section',
    fields: [
      {
        type: 'mrkdwn',
        text: `*On-Call:*\n<@${devinUserId}>`,
      },
    ],
  });

  // Action buttons
  const actions = [];
  if (alertData.issueUrl) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: ':mag: View in Sentry', emoji: true },
      url: alertData.issueUrl,
    });
  }
  actions.push({
    type: 'button',
    text: { type: 'plain_text', text: ':bar_chart: View in Datadog', emoji: true },
    url: 'https://app.us5.datadoghq.com/dashboard/y6q-9d9-7vg',
  });
  if (actions.length > 0) {
    blocks.push({ type: 'actions', elements: actions });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Service: \`${alertData.service || 'checkout-api'}\` | ${new Date().toISOString()}`,
      },
    ],
  });

  return blocks;
}

/**
 * Build a plain-text fallback for the alert message.
 */
function buildAlertText(alertData) {
  let text = `:rotating_light: *Sentry Alert — ${alertData.issueTitle}*\n`;
  text += `Type: ${alertData.errorType || 'unknown'} | Level: ${alertData.level || 'error'}\n`;
  if (alertData.errorValue) {
    text += `Message: ${alertData.errorValue}\n`;
  }
  if (alertData.issueUrl) {
    text += `Sentry Issue: ${alertData.issueUrl}`;
  }
  return text;
}

/**
 * Post the initial alert to Slack and return the thread timestamp.
 */
async function postAlertToSlack(alertData) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  if (!token || !channel) {
    logger.warn('Slack not configured — skipping alert post (SLACK_BOT_TOKEN or SLACK_CHANNEL_ID missing)');
    return null;
  }

  try {
    const text = buildAlertText(alertData);
    const blocks = buildAlertBlocks(alertData);
    const threadTs = await postMessage(token, channel, text, blocks);

    logger.info('Alert posted to Slack', { channel, threadTs });
    return threadTs;
  } catch (error) {
    logger.error('Failed to post alert to Slack', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    return null;
  }
}

/**
 * Reply in the alert thread with @Devin + prompt using the user token.
 * Because the message comes from a user token (not a bot), Slack treats it
 * as a human message and the Devin app responds to the @mention natively.
 */
async function postDevinReply(threadTs, prompt) {
  const userToken = process.env.SLACK_USER_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  const devinUserId = process.env.DEVIN_SLACK_USER_ID || 'U08RNEJ4877';

  if (!userToken || !channel) {
    logger.warn('SLACK_USER_TOKEN not configured — cannot trigger Devin via Slack');
    return null;
  }

  try {
    const text = `<@${devinUserId}> ${prompt}`;
    const replyTs = await postThreadReply(userToken, channel, threadTs, text);

    logger.info('Devin reply posted via user token', { channel, threadTs, replyTs });

    // Auto-delete the trigger message after a short delay so it looks like
    // Devin responded to the alert directly without a visible human prompt
    if (replyTs) {
      setTimeout(async () => {
        try {
          await deleteMessage(userToken, channel, replyTs);
          logger.info('Trigger message auto-deleted', { channel, replyTs });
        } catch (err) {
          logger.warn('Failed to auto-delete trigger message', { error: err.message });
        }
      }, 5000);
    }

    return replyTs;
  } catch (error) {
    logger.error('Failed to post Devin reply', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    return null;
  }
}

/**
 * Delete a Slack message. Used to clean up the @Devin trigger message
 * after Devin has acknowledged it.
 */
async function deleteMessage(token, channel, ts) {
  const response = await axios.post(`${SLACK_API_BASE}/chat.delete`, {
    channel,
    ts,
  }, {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    timeout: 10000,
  });

  if (!response.data.ok) {
    throw new Error(`Slack API error: ${response.data.error}`);
  }
}

module.exports = {
  postAlertToSlack,
  postDevinReply,
  postThreadReply,
};
