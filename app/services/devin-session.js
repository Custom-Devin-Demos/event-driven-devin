const logger = require('../telemetry/logger');
const { postAlertToSlack, postDevinSessionLink } = require('./slack');
const { createDevinSession } = require('./devin-api');
const { scheduleVulnerablePR } = require('./sonar-pr-trigger');
const { getCustomerConfig } = require('../../config/customers');

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
 * Post an alert to Slack and trigger Devin investigation via the v3 API.
 *
 * Flow:
 *   1. Post the rich alert message to Slack using the bot token
 *   2. Create a Devin session via POST /v3/organizations/{org_id}/sessions
 *      — Uses create_as_user_id so the session appears in the selected user's account
 *   3. Post a "View in Devin" button in the Slack thread
 *
 * Per-customer config is resolved from alertData.customer (see config/customers.js).
 * If no customer is specified, the default global env vars are used.
 *
 * @param {Object} alertData - Normalized alert data (issueTitle, errorType, etc.)
 * @param {string} [alertData.customer] - Customer slug for per-customer config
 * @param {string} [alertData.devinUserId] - Devin user ID for per-user session creation
 * @param {string} [alertData.devinOrgId] - Devin org ID for per-org session creation
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

    // Resolve per-customer Devin configuration
    const config = getCustomerConfig(alertData.customer);

    // Attach config to alertData so downstream functions (e.g. buildAlertBlocks)
    // can use it without additional parameters
    alertData.customerConfig = config;

    logger.info('Posting alert and triggering Devin', {
      issueTitle: alertData.issueTitle,
      errorType: alertData.errorType,
      errorValue: alertData.errorValue,
      customer: config.customer,
      devinUserId: alertData.devinUserId || 'none',
      devinOrgId: alertData.devinOrgId || 'default',
    });

    // Step 1: Post the rich alert message (bot token)
    const threadTs = await postAlertToSlack(alertData);

    if (!threadTs) {
      logger.warn('Alert post returned no thread timestamp — cannot trigger Devin reply');
      sessionCooldowns.delete(cooldownKey);
      return null;
    }

    // Step 2: Create Devin session via v3 API and post "View in Devin" link
    const session = await createDevinSession(prompt, {
      apiKey: config.apiKey,
      orgId: alertData.devinOrgId,
      userId: alertData.devinUserId,
    });

    if (session) {
      await postDevinSessionLink(threadTs, session.url);
      logger.info('Devin session created and linked in Slack thread', {
        issueTitle: alertData.issueTitle,
        sessionId: session.sessionId,
        customer: config.customer,
        devinUserId: alertData.devinUserId || 'service-user',
        devinOrgId: alertData.devinOrgId || 'default',
        threadTs,
      });
    } else {
      logger.warn('Devin session was not created — API call failed or not configured', {
        customer: config.customer,
      });
    }

    // Fire a vulnerable PR in the target repo immediately.
    // This triggers SonarCloud -> quality gate failure -> Devin auto-remediation
    // in the background, demonstrating the full remediation pipeline.
    // Pass the customer slug and devinUserId so the workflow dispatch includes them,
    // allowing devin-scan.yml to create the remediation session as the selected user.
    scheduleVulnerablePR(0, config.customer, alertData.devinUserId, alertData.devinOrgId);

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
