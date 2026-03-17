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

  // Build a compact, scannable prompt.
  // Use null as skip sentinel so intentional blank-line separators ('') are preserved.
  const lines = [
    '!sentry_investigation',
    '',
    `*Error:* ${issueTitle}`,
    culprit ? `*Location:* \`${culprit}\`` : null,
    errorType ? `*Type:* ${errorType}` : null,
    errorValue ? `*Message:* ${errorValue}` : null,
    alertData.service ? `*Service:* ${alertData.service}` : null,
  ];

  // Compact metadata line — combine small fields with pipe separators
  const metaParts = [
    `Level: ${level || 'error'}`,
    project ? `Project: ${project}` : null,
    environment ? `Env: ${environment}` : null,
    release ? `Release: ${release}` : null,
  ].filter(Boolean);
  if (metaParts.length > 0) {
    lines.push('', metaParts.join(' | '));
  }

  // Event history line
  const historyParts = [
    count ? `Events: ${count}` : null,
    firstSeen ? `First: ${firstSeen}` : null,
    lastSeen ? `Last: ${lastSeen}` : null,
  ].filter(Boolean);
  if (historyParts.length > 0) {
    lines.push(historyParts.join(' | '));
  }

  // Extra identifiers
  if (shortId) lines.push(`Short ID: ${shortId}`);
  if (triggeredRule) lines.push(`Rule: ${triggeredRule}`);

  // Sentry link
  if (issueUrl) lines.push('', issueUrl);

  // Tags — inline comma-separated for compactness
  if (tags && tags.length > 0) {
    const tagPairs = tags
      .map((t) => {
        const key = t.key || t[0] || '';
        const value = t.value || t[1] || '';
        return key ? `${key}: ${value}` : null;
      })
      .filter(Boolean);
    if (tagPairs.length > 0) {
      lines.push('', `*Tags:* ${tagPairs.join(', ')}`);
    }
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
