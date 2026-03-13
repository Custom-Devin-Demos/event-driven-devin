const axios = require('axios');
const logger = require('../telemetry/logger');

const SLACK_API_BASE = 'https://slack.com/api';
const DEVIN_API_BASE = 'https://api.devin.ai/v3';

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
function buildAlertBlocks(alertData, sessionUrl) {
  const blocks = [
    {
      type: 'header',
      text: {
        type: 'plain_text',
        text: ':rotating_light: Sentry Alert — Checkout Error',
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
        text: `*Release:*\n${alertData.release || 'unknown'}`,
      },
      {
        type: 'mrkdwn',
        text: `*Environment:*\n${alertData.environment || 'unknown'}`,
      },
    ],
  });

  // Action buttons
  const actions = [];
  if (sessionUrl) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: ':robot_face: View Devin Session', emoji: true },
      url: sessionUrl,
      style: 'primary',
    });
  }
  if (alertData.issueUrl) {
    actions.push({
      type: 'button',
      text: { type: 'plain_text', text: ':mag: View in Sentry', emoji: true },
      url: alertData.issueUrl,
    });
  }
  if (actions.length > 0) {
    blocks.push({ type: 'actions', elements: actions });
  }

  blocks.push({
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: `Service: \`checkout-api\` | ${new Date().toISOString()}`,
      },
    ],
  });

  return blocks;
}

/**
 * Build a plain-text fallback for the alert message.
 */
function buildAlertText(alertData, sessionUrl) {
  let text = `:rotating_light: *Sentry Alert — ${alertData.issueTitle}*\n`;
  text += `Type: ${alertData.errorType || 'unknown'} | Level: ${alertData.level || 'error'}\n`;
  if (alertData.errorValue) {
    text += `Message: ${alertData.errorValue}\n`;
  }
  if (sessionUrl) {
    text += `Devin Session: ${sessionUrl}\n`;
  }
  if (alertData.issueUrl) {
    text += `Sentry Issue: ${alertData.issueUrl}`;
  }
  return text;
}

/**
 * Post the initial alert to Slack and return the thread timestamp.
 */
async function postAlertToSlack(alertData, sessionUrl) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  if (!token || !channel) {
    logger.warn('Slack not configured — skipping alert post (SLACK_BOT_TOKEN or SLACK_CHANNEL_ID missing)');
    return null;
  }

  try {
    const text = buildAlertText(alertData, sessionUrl);
    const blocks = buildAlertBlocks(alertData, sessionUrl);
    const threadTs = await postMessage(token, channel, text, blocks);

    logger.info('Alert posted to Slack', { channel, threadTs, sessionUrl });
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
 * Fetch the current status and latest messages from a Devin session.
 */
async function fetchSessionStatus(sessionId) {
  const apiKey = process.env.DEVIN_API_KEY;
  const orgId = process.env.DEVIN_ORG_ID;

  if (!apiKey || !orgId) {
    return null;
  }

  const devinId = sessionId.startsWith('devin-') ? sessionId : `devin-${sessionId}`;

  const response = await axios.get(
    `${DEVIN_API_BASE}/organizations/${orgId}/sessions/${devinId}`,
    {
      headers: { 'Authorization': `Bearer ${apiKey}` },
      timeout: 15000,
    }
  );

  return response.data;
}

/**
 * Poll a Devin session for updates and post them back to a Slack thread.
 *
 * Tracks: status changes, PR creation, and completion.
 * Stops polling when session reaches a terminal state.
 */
function startSessionPoller(sessionId, channel, threadTs) {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token || !channel || !threadTs) {
    return;
  }

  let lastStatus = 'running';
  let prNotified = false;
  let pollCount = 0;
  const MAX_POLLS = 120; // 120 * 30s = 60 minutes max
  const POLL_INTERVAL_MS = 30000;

  const interval = setInterval(async () => {
    pollCount++;

    if (pollCount > MAX_POLLS) {
      logger.info('Session poller max polls reached, stopping', { sessionId });
      clearInterval(interval);
      return;
    }

    try {
      const session = await fetchSessionStatus(sessionId);
      if (!session) {
        clearInterval(interval);
        return;
      }

      const status = session.status || session.status_enum || 'unknown';

      // Notify on status change
      if (status !== lastStatus) {
        const statusEmoji = {
          'running': ':hourglass_flowing_sand:',
          'blocked': ':warning:',
          'stopped': ':white_check_mark:',
          'finished': ':white_check_mark:',
          'failed': ':x:',
          'suspended': ':zzz:',
        };
        const emoji = statusEmoji[status] || ':information_source:';

        await postThreadReply(token, channel, threadTs,
          `${emoji} Devin session status: *${status}*`,
        );
        lastStatus = status;
      }

      // Notify about PR creation
      if (!prNotified && session.pull_request) {
        const prUrl = session.pull_request.url || session.pull_request.html_url || '';
        if (prUrl) {
          await postThreadReply(token, channel, threadTs,
            `:github: Devin created a PR: <${prUrl}|View Pull Request>`,
            [
              {
                type: 'section',
                text: {
                  type: 'mrkdwn',
                  text: `:github: *Pull Request Created*\n<${prUrl}|${session.pull_request.title || 'View PR'}>`,
                },
              },
            ],
          );
          prNotified = true;
        }
      }

      // Stop polling on terminal states
      if (['stopped', 'finished', 'failed'].includes(status)) {
        logger.info('Session reached terminal state, stopping poller', { sessionId, status });

        const sessionUrl = session.url || `https://app.devin.ai/sessions/${sessionId}`;
        await postThreadReply(token, channel, threadTs,
          `:checkered_flag: Investigation complete — <${sessionUrl}|View full session>`,
        );

        clearInterval(interval);
      }
    } catch (error) {
      logger.error('Session poll error', {
        sessionId,
        error: error.message,
        pollCount,
      });
      // Don't stop polling on transient errors
    }
  }, POLL_INTERVAL_MS);

  logger.info('Session poller started', { sessionId, channel, threadTs });
}

module.exports = {
  postAlertToSlack,
  postThreadReply,
  startSessionPoller,
};
