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
 * Look up a Slack user by their email address.
 * Returns the Slack member ID (e.g. "U12345") or null if not found.
 * Uses the Slack `users.lookupByEmail` API.
 */
async function lookupSlackUserByEmail(token, email) {
  if (!token || !email) return null;

  try {
    const response = await axios.get(`${SLACK_API_BASE}/users.lookupByEmail`, {
      headers: { Authorization: `Bearer ${token}` },
      params: { email },
      timeout: 10000,
    });

    if (!response.data.ok) {
      // users_not_found is expected when the email isn't in the workspace
      if (response.data.error !== 'users_not_found') {
        logger.warn('Slack lookupByEmail failed', { error: response.data.error, email });
      }
      return null;
    }

    return response.data.user?.id || null;
  } catch (error) {
    logger.warn('Slack lookupByEmail request failed', { error: error.message, email });
    return null;
  }
}

/**
 * Build Slack blocks for the initial Sentry alert message.
 *
 * @param {Object} alertData - Normalized alert data
 * @param {Object} [options]
 * @param {boolean} [options.includeDevinOnCall=true] - Whether to include the
 *   ":robot_face: Devin AI (auto-investigating)" on-call line. Set to false for
 *   the triage channel mirror, which is report-only (no Devin session).
 */
function buildAlertBlocks(alertData, options = {}) {
  const { includeDevinOnCall = true } = options;
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

  // On-Call section: show Devin AI (v3 API mode — no @mention spoofing).
  // Omitted for the triage mirror, which is report-only (no Devin session).
  const onCallFields = [];
  if (includeDevinOnCall) {
    onCallFields.push({
      type: 'mrkdwn',
      text: '*On-Call:*\n:robot_face: Devin AI (auto-investigating)',
    });
  }

  // Tag the demo user as on-call so they get a Slack notification for their alert
  if (alertData.slackMemberId) {
    onCallFields.push({
      type: 'mrkdwn',
      text: `*On-Call:*\n<@${alertData.slackMemberId}>`,
    });
  }

  if (onCallFields.length > 0) {
    blocks.push({
      type: 'section',
      fields: onCallFields,
    });
  }

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
    url: process.env.DD_DASHBOARD_URL || 'https://app.datadoghq.com',
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
 * If alertData.devinEmail is set, resolves the email to a Slack member ID
 * and @mentions the user in the alert so they get a notification.
 */
async function postAlertToSlack(alertData) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  if (!token || !channel) {
    logger.warn('Slack not configured — skipping alert post (SLACK_BOT_TOKEN or SLACK_CHANNEL_ID missing)');
    return null;
  }

  try {
    // Resolve the demo user's email to a Slack member ID for @mentioning
    if (alertData.devinEmail && !alertData.slackMemberId) {
      const memberId = await lookupSlackUserByEmail(token, alertData.devinEmail);
      if (memberId) {
        alertData.slackMemberId = memberId;
        logger.info('Resolved demo user Slack ID from email', {
          email: alertData.devinEmail,
          slackMemberId: memberId,
        });
      }
    }

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
 * Mirror the bug report to the dedicated triage channel (#automated-devin-triage).
 *
 * This is a report-only copy: it posts the same Sentry alert card (minus the
 * "Devin AI (auto-investigating)" on-call line) and intentionally does NOT
 * trigger a Devin session or any thread follow-ups. Fire-and-forget — failures
 * are logged and never affect the primary alert/Devin flow.
 *
 * Channel/token are configurable via env:
 *   SLACK_TRIAGE_CHANNEL_ID   — target channel (default: #automated-devin-triage)
 *   SLACK_TRIAGE_BOT_TOKEN    — bot token override (default: SLACK_BOT_TOKEN)
 *
 * The bot must be a member of the triage channel (invite it with
 * `/invite @<bot>` in #automated-devin-triage).
 */
async function postBugReportToTriage(alertData) {
  const token = process.env.SLACK_TRIAGE_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  // Defaults to the #automated-devin-triage channel in the Cog GTM [DEMO] workspace.
  const channel = process.env.SLACK_TRIAGE_CHANNEL_ID || 'C0B74QWEEVD';

  if (!token || !channel) {
    logger.warn('Triage channel not configured — skipping bug report mirror');
    return null;
  }

  try {
    const text = buildAlertText(alertData);
    const blocks = buildAlertBlocks(alertData, { includeDevinOnCall: false });
    const ts = await postMessage(token, channel, text, blocks);

    logger.info('Bug report mirrored to triage channel', { channel, ts });
    return ts;
  } catch (error) {
    const slackError = error.message || '';
    if (slackError.includes('not_in_channel')) {
      logger.warn('Bug report mirror failed — bot is not in the triage channel', {
        channel,
        hint: 'Invite the bot with `/invite @<bot>` in #automated-devin-triage',
      });
    } else {
      logger.error('Failed to mirror bug report to triage channel', {
        error: error.message,
        channel,
      });
    }
    return null;
  }
}

/**
 * Reply in the alert thread with @Devin + prompt using the user token.
 * Because the message comes from a user token (not a bot), Slack treats it
 * as a human message and the Devin app responds to the @mention natively.
 *
 * Used in "slack" trigger mode (DEVIN_TRIGGER_MODE=slack, the default).
 */
async function postDevinReply(threadTs, prompt, options = {}) {
  const userToken = process.env.SLACK_USER_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;
  const devinUserId = options.slackUserId || process.env.DEVIN_SLACK_USER_ID || '';

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
 * Post a thread reply with a link to the Devin investigation session.
 * Uses the bot token — no user token needed.
 *
 * Used in "api" trigger mode (DEVIN_TRIGGER_MODE=api).
 */
async function postDevinSessionLink(threadTs, sessionUrl) {
  const token = process.env.SLACK_BOT_TOKEN;
  const channel = process.env.SLACK_CHANNEL_ID;

  if (!token || !channel) {
    logger.warn('Slack not configured — skipping Devin session link post');
    return null;
  }

  try {
    const blocks = [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: ':robot_face: *Devin is investigating this issue.*',
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: { type: 'plain_text', text: ':computer: View in Devin', emoji: true },
            url: sessionUrl,
            style: 'primary',
          },
        ],
      },
    ];

    const text = `Devin is investigating: ${sessionUrl}`;
    const replyTs = await postThreadReply(token, channel, threadTs, text, blocks);

    logger.info('Devin session link posted to Slack thread', { channel, threadTs, replyTs, sessionUrl });
    return replyTs;
  } catch (error) {
    logger.error('Failed to post Devin session link', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });
    return null;
  }
}

/**
 * Delete a Slack message. Used to clean up the @Devin trigger message
 * after Devin has acknowledged it (slack trigger mode only).
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
  postBugReportToTriage,
  postDevinSessionLink,
  postThreadReply,
  lookupSlackUserByEmail,
};
