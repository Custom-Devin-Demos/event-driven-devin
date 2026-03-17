const logger = require('../telemetry/logger');
const { postAlertToSlack, postDevinReply } = require('./slack');

/**
 * In-memory cooldown map to prevent duplicate alerts.
 * Key: normalized issue identifier, Value: timestamp of last alert.
 * Cooldown: 5 minutes (matches alert rule frequency).
 */
const sessionCooldowns = new Map();
const COOLDOWN_MS = 5 * 60 * 1000;

// Periodically evict expired cooldown entries to prevent unbounded Map growth
setInterval(() => {
  const now = Date.now();
  for (const [key, ts] of sessionCooldowns) {
    if (now - ts >= COOLDOWN_MS) {
      sessionCooldowns.delete(key);
    }
  }
}, COOLDOWN_MS);

/**
 * Build the investigation prompt from alert data.
 * Uses the !sentry_investigation playbook macro so Devin follows
 * the standardized investigation & remediation workflow automatically.
 * Only the essential alert context is included — the playbook handles
 * the investigation steps, Sentry/Datadog queries, and fix process.
 */
function buildPrompt(alertData) {
  const {
    issueTitle, issueUrl, culprit, errorType, errorValue,
    tags, level, firstSeen, lastSeen,
    count, shortId, project, release, environment, triggeredRule,
  } = alertData;

  // Use null as skip sentinel for optional fields so that intentional
  // blank-line separators ('') are preserved by the filter.
  const lines = [
    '!sentry_investigation',
    '',
    `*Error:* ${issueTitle}`,
    culprit ? `*Location:* \`${culprit}\`` : null,
    errorType ? `*Type:* ${errorType}` : null,
    errorValue ? `*Message:* ${errorValue}` : null,
    alertData.service ? `*Service:* ${alertData.service}` : null,
    `*Level:* ${level || 'error'}`,
    shortId ? `*Short ID:* ${shortId}` : null,
    triggeredRule ? `*Triggered Rule:* ${triggeredRule}` : null,
    firstSeen ? `*First Seen:* ${firstSeen}` : null,
    lastSeen ? `*Last Seen:* ${lastSeen}` : null,
    count ? `*Event Count:* ${count}` : null,
    project ? `*Project:* ${project}` : null,
    release ? `*Release:* ${release}` : null,
    environment ? `*Environment:* ${environment}` : null,
    issueUrl ? `*Sentry Issue:* ${issueUrl}` : null,
  ];

  if (tags && tags.length > 0) {
    lines.push('', '*Tags:*');
    tags.forEach((t) => {
      const key = t.key || t[0] || '';
      const value = t.value || t[1] || '';
      if (key) lines.push(`  ${key}: ${value}`);
    });
  }

  return lines
    .filter((l) => l !== null)
    .join('\n');
}

/**
 * Post an alert to Slack and trigger Devin via native Slack integration.
 *
 * Flow:
 *   1. Post the rich alert message using the bot token (appears as "Automated Alerts")
 *   2. Reply in the thread using a user token with @Devin + investigation prompt
 *      — Slack treats user-token messages as coming from a real human
 *      — The Devin Slack app picks up the @mention and starts a session natively
 *
 * This replaces the previous API-based session creation + custom poller approach.
 * The native Devin Slack integration provides live thread updates, PR links,
 * and interactive conversation — much richer than our custom poller.
 *
 * @param {Object} alertData - Normalized alert data (issueTitle, errorType, etc.)
 * @returns {Object|null} - { triggered: true, threadTs } or null if skipped/failed
 */
async function createSessionAndAlert(alertData) {
  // Cooldown check
  const cooldownKey = `${alertData.issueTitle}`.toLowerCase().trim();
  const lastCreated = sessionCooldowns.get(cooldownKey);
  if (lastCreated && (Date.now() - lastCreated) < COOLDOWN_MS) {
    const remainingMin = Math.round((COOLDOWN_MS - (Date.now() - lastCreated)) / 60000);
    logger.info('Skipping duplicate — alert already sent recently', {
      issueTitle: alertData.issueTitle,
      cooldownRemainingMin: remainingMin,
    });
    return null;
  }

  // Mark cooldown immediately to prevent races
  sessionCooldowns.set(cooldownKey, Date.now());

  try {
    const prompt = buildPrompt(alertData);

    logger.info('Posting alert and triggering Devin via Slack', {
      issueTitle: alertData.issueTitle,
      errorType: alertData.errorType,
      errorValue: alertData.errorValue,
    });

    // Step 1: Post the rich alert message (bot token)
    const threadTs = await postAlertToSlack(alertData);

    if (!threadTs) {
      logger.warn('Alert post returned no thread timestamp — cannot trigger Devin reply');
      sessionCooldowns.delete(cooldownKey);
      return null;
    }

    // Step 2: Reply with @Devin + prompt using user token (triggers native Devin integration)
    const replyTs = await postDevinReply(threadTs, prompt);

    if (!replyTs) {
      logger.warn('Devin reply was not posted — trigger failed');
      sessionCooldowns.delete(cooldownKey);
      return null;
    }

    logger.info('Devin triggered via native Slack integration', {
      issueTitle: alertData.issueTitle,
      threadTs,
    });

    return { triggered: true, threadTs };
  } catch (error) {
    // Clear cooldown so the next attempt can retry
    sessionCooldowns.delete(cooldownKey);

    logger.error('Failed to post alert or trigger Devin', {
      error: error.message,
      status: error.response?.status,
      data: error.response?.data,
    });

    return null;
  }
}

module.exports = {
  buildPrompt,
  createSessionAndAlert,
  sessionCooldowns,
  COOLDOWN_MS,
};
