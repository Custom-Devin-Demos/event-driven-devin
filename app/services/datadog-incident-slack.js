const logger = require('../telemetry/logger');
const { findChannelByNameFragment, joinChannel, inviteToChannel } = require('./slack');

const CHANNEL_RETRY_MS = 5000;
const MAX_ATTEMPTS = 24;
const USER_ID_RE = /^U[A-Z0-9]{8,31}$/;

// Datadog creates incident channels asynchronously, after its declaration API returns.
function queueIncidentChannelInvites({ publicId, userIds } = {}) {
  if (typeof publicId === 'string' && /^[1-9][0-9]*$/.test(publicId)) publicId = Number(publicId);
  const users = Array.isArray(userIds) ? [...new Set(userIds.filter((id) => typeof id === 'string' && USER_ID_RE.test(id)))] : [];
  if (!Number.isSafeInteger(publicId) || publicId <= 0 || !users.length) return false;
  const token = process.env.INCIDENT_LAB_SLACK_BOT_TOKEN || process.env.SLACK_ONCALL_BOT_TOKEN || process.env.SLACK_BOT_TOKEN;
  if (!token) {
    logger.warn('Incident channel invites unavailable: Slack bot token is not configured', { publicId });
    return false;
  }
  let attempts = 0;
  let channel = null;
  const pending = new Set(users);
  const attempt = async () => {
    attempts++;
    try {
      channel = channel || await findChannelByNameFragment(token, `incident-${publicId}-`);
      if (channel) {
        await joinChannel(token, channel.id);
        for (const user of pending) {
          if (await inviteToChannel(token, channel.id, [user])) pending.delete(user);
        }
        if (!pending.size) {
          logger.info('Incident channel participants invited', { publicId, channel: channel.id, users });
          return;
        }
      }
    } catch (error) {
      logger.warn('Incident channel invite attempt failed', { publicId, error: error.message });
    }
    if (attempts >= MAX_ATTEMPTS) {
      logger.warn('Incident channel invitations exhausted retries', { publicId, channel: channel && channel.id });
      return;
    }
    setTimeout(attempt, CHANNEL_RETRY_MS).unref();
  };
  void attempt();
  return true;
}

module.exports = { queueIncidentChannelInvites, CHANNEL_RETRY_MS, MAX_ATTEMPTS };
